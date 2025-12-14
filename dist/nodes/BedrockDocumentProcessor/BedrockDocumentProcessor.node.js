"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AmazonTextractOCR = void 0;
const n8n_workflow_1 = require("n8n-workflow");
const crypto_1 = require("crypto");
const client_textract_1 = require("@aws-sdk/client-textract");
const client_s3_1 = require("@aws-sdk/client-s3");
class AmazonTextractOCR {
    constructor() {
        this.description = {
            displayName: 'Amazon Textract OCR',
            name: 'amazonTextractOCR',
            icon: 'file:textract.svg',
            group: ['transform'],
            version: 1,
            description: 'Extract text from images and PDFs using Amazon Textract',
            defaults: { name: 'Amazon Textract OCR' },
            inputs: ['main'],
            outputs: ['main'],
            credentials: [
                {
                    name: 'aws',
                    required: true,
                },
            ],
            properties: [
                {
                    displayName: 'S3 Bucket',
                    name: 's3Bucket',
                    type: 'string',
                    required: true,
                    default: '',
                    description: 'S3 bucket to upload PDFs (must already exist)',
                },
                {
                    displayName: 'S3 Key Prefix',
                    name: 's3Prefix',
                    type: 'string',
                    required: false,
                    default: '',
                    description: 'Optional prefix to place uploaded objects under',
                },
                {
                    displayName: 'File Source',
                    name: 'fileSource',
                    type: 'options',
                    options: [
                        { name: 'Binary Data', value: 'binary' },
                        { name: 'Base64 String', value: 'base64' },
                    ],
                    default: 'binary',
                },
                {
                    displayName: 'Binary Property',
                    name: 'binaryProperty',
                    type: 'string',
                    default: 'data',
                    required: true,
                    displayOptions: { show: { fileSource: ['binary'] } },
                },
                {
                    displayName: 'Base64 Content',
                    name: 'base64Content',
                    type: 'string',
                    default: '={{$json.file_content}}',
                    displayOptions: { show: { fileSource: ['base64'] } },
                },
                {
                    displayName: 'File MIME Type',
                    name: 'fileType',
                    type: 'string',
                    default: 'application/pdf',
                    displayOptions: { show: { fileSource: ['base64'] } },
                    description: 'e.g. application/pdf, image/png',
                },
                {
                    displayName: 'Polling Timeout (seconds)',
                    name: 'timeoutSeconds',
                    type: 'number',
                    default: 120,
                    description: 'Max seconds to wait for async Textract job (for PDFs)',
                },
            ],
        };
    }
    async execute() {
        var _a, _b, _c, _d, _e, _f, _g, _h, _j;
        const items = this.getInputData();
        const returnData = [];
        const credentials = (await this.getCredentials('aws'));
        if (!credentials || !credentials.accessKeyId || !credentials.secretAccessKey) {
            throw new n8n_workflow_1.NodeOperationError(this.getNode(), 'AWS credentials are missing or incomplete');
        }
        const s3Bucket = this.getNodeParameter('s3Bucket', 0);
        const s3Prefix = this.getNodeParameter('s3Prefix', 0) || '';
        const timeoutSeconds = this.getNodeParameter('timeoutSeconds', 0);
        if (!s3Bucket) {
            throw new n8n_workflow_1.NodeOperationError(this.getNode(), 'S3 bucket must be provided');
        }
        const region = credentials.region || this.getNodeParameter('region', 0) || undefined;
        const s3Client = new client_s3_1.S3Client({
            region,
            credentials: {
                accessKeyId: credentials.accessKeyId,
                secretAccessKey: credentials.secretAccessKey,
            },
        });
        const textractClient = new client_textract_1.TextractClient({
            region,
            credentials: {
                accessKeyId: credentials.accessKeyId,
                secretAccessKey: credentials.secretAccessKey,
            },
        });
        for (let i = 0; i < items.length; i++) {
            let uploadedKey;
            try {
                const fileSource = this.getNodeParameter('fileSource', i);
                let fileBuffer;
                let fileType;
                if (fileSource === 'binary') {
                    const binaryProperty = this.getNodeParameter('binaryProperty', i);
                    const binaryData = this.helpers.assertBinaryData(i, binaryProperty);
                    fileBuffer = await this.helpers.getBinaryDataBuffer(i, binaryProperty);
                    fileType = binaryData.mimeType;
                }
                else {
                    const base64Content = this.getNodeParameter('base64Content', i);
                    fileType = this.getNodeParameter('fileType', i);
                    fileBuffer = Buffer.from(base64Content, 'base64');
                }
                const isPdf = fileType === 'application/pdf';
                const isImage = fileType.startsWith('image/');
                if (!isPdf && !isImage) {
                    throw new n8n_workflow_1.NodeOperationError(this.getNode(), `Unsupported MIME type: ${fileType}`);
                }
                let extractedText = '';
                if (isImage) {
                    const detectCmd = new client_textract_1.DetectDocumentTextCommand({
                        Document: { Bytes: fileBuffer },
                    });
                    const resp = await textractClient.send(detectCmd);
                    const blocks = (_a = resp.Blocks) !== null && _a !== void 0 ? _a : [];
                    const lines = [];
                    for (const b of blocks) {
                        const bt = b.BlockType;
                        const txt = (_c = (_b = b.Text) !== null && _b !== void 0 ? _b : b.DetectedText) !== null && _c !== void 0 ? _c : '';
                        if (bt === 'LINE' && txt)
                            lines.push(txt);
                    }
                    extractedText = lines.join('\n');
                }
                else {
                    const key = `${s3Prefix}${s3Prefix && !s3Prefix.endsWith('/') ? '/' : ''}${Date.now()}-${(0, crypto_1.randomUUID)()}.pdf`;
                    uploadedKey = key;
                    await s3Client.send(new client_s3_1.PutObjectCommand({ Bucket: s3Bucket, Key: key, Body: fileBuffer, ContentType: fileType }));
                    const startCmd = new client_textract_1.StartDocumentTextDetectionCommand({
                        DocumentLocation: { S3Object: { Bucket: s3Bucket, Name: key } },
                    });
                    const startResp = await textractClient.send(startCmd);
                    const jobId = startResp.JobId;
                    if (!jobId)
                        throw new n8n_workflow_1.NodeOperationError(this.getNode(), 'Failed to start Textract job');
                    const startTime = Date.now();
                    const timeoutAt = startTime + (timeoutSeconds || 120) * 1000;
                    let jobStatus;
                    let getResp = null;
                    while (Date.now() < timeoutAt) {
                        await new Promise((res) => setTimeout(res, 3000));
                        getResp = await textractClient.send(new client_textract_1.GetDocumentTextDetectionCommand({ JobId: jobId }));
                        jobStatus = getResp.JobStatus;
                        if (jobStatus === 'SUCCEEDED' || jobStatus === 'FAILED')
                            break;
                    }
                    if (jobStatus !== 'SUCCEEDED') {
                        throw new n8n_workflow_1.NodeOperationError(this.getNode(), `Textract job did not complete successfully: ${jobStatus}`);
                    }
                    const allBlocks = [];
                    let nextToken = getResp.NextToken;
                    allBlocks.push(...((_d = getResp.Blocks) !== null && _d !== void 0 ? _d : []));
                    while (nextToken) {
                        const pageResp = await textractClient.send(new client_textract_1.GetDocumentTextDetectionCommand({ JobId: jobId, NextToken: nextToken }));
                        allBlocks.push(...((_e = pageResp.Blocks) !== null && _e !== void 0 ? _e : []));
                        nextToken = pageResp.NextToken || undefined;
                    }
                    const lines = [];
                    for (const b of allBlocks) {
                        const bt = b.BlockType;
                        const txt = (_g = (_f = b.Text) !== null && _f !== void 0 ? _f : b.DetectedText) !== null && _g !== void 0 ? _g : '';
                        if (bt === 'LINE' && txt)
                            lines.push(txt);
                    }
                    extractedText = lines.join('\n');
                }
                returnData.push({ json: { text: extractedText } });
            }
            catch (error) {
                const errMsg = (_h = error === null || error === void 0 ? void 0 : error.message) !== null && _h !== void 0 ? _h : String(error);
                if (this.continueOnFail()) {
                    returnData.push({ json: { error: errMsg } });
                    continue;
                }
                throw new n8n_workflow_1.NodeOperationError(this.getNode(), errMsg);
            }
            finally {
                if (uploadedKey) {
                    try {
                        await s3Client.send(new client_s3_1.DeleteObjectCommand({ Bucket: s3Bucket, Key: uploadedKey }));
                    }
                    catch (e) {
                        if (this.continueOnFail()) {
                            returnData.push({ json: { warning: `Failed to delete S3 object ${uploadedKey}: ${(_j = e === null || e === void 0 ? void 0 : e.message) !== null && _j !== void 0 ? _j : e}` } });
                        }
                    }
                }
            }
        }
        return [returnData];
    }
}
exports.AmazonTextractOCR = AmazonTextractOCR;
//# sourceMappingURL=BedrockDocumentProcessor.node.js.map