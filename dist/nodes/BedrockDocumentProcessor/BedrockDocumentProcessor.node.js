"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BedrockDocumentProcessor = void 0;
const n8n_workflow_1 = require("n8n-workflow");
const client_bedrock_runtime_1 = require("@aws-sdk/client-bedrock-runtime");
class BedrockDocumentProcessor {
    constructor() {
        this.description = {
            displayName: 'Bedrock Document Processor',
            name: 'bedrockDocumentProcessor',
            icon: 'file:bedrock.svg',
            group: ['transform'],
            version: 1,
            description: 'Process documents and images using AWS Bedrock Claude',
            defaults: {
                name: 'Bedrock Document Processor',
            },
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
                    displayName: 'Region',
                    name: 'region',
                    type: 'string',
                    default: 'eu-central-1',
                    description: 'AWS region where Bedrock is available',
                },
                {
                    displayName: 'Model ID',
                    name: 'modelId',
                    type: 'string',
                    default: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
                    description: 'Bedrock model ID to use',
                },
                {
                    displayName: 'Message',
                    name: 'message',
                    type: 'string',
                    default: 'Extract all text from this file',
                    description: 'Instruction to send to Claude',
                    typeOptions: {
                        rows: 4,
                    },
                },
                {
                    displayName: 'File Source',
                    name: 'fileSource',
                    type: 'options',
                    options: [
                        {
                            name: 'Binary Data',
                            value: 'binary',
                        },
                        {
                            name: 'Base64 String',
                            value: 'base64',
                        },
                    ],
                    default: 'binary',
                    description: 'Where to get the file from',
                },
                {
                    displayName: 'Binary Property',
                    name: 'binaryProperty',
                    type: 'string',
                    default: 'data',
                    required: true,
                    displayOptions: {
                        show: {
                            fileSource: ['binary'],
                        },
                    },
                    description: 'Name of the binary property containing the file',
                },
                {
                    displayName: 'Base64 Content',
                    name: 'base64Content',
                    type: 'string',
                    default: '={{$json.file_content}}',
                    displayOptions: {
                        show: {
                            fileSource: ['base64'],
                        },
                    },
                    description: 'Base64 encoded file content',
                },
                {
                    displayName: 'File Type',
                    name: 'fileType',
                    type: 'string',
                    default: 'application/pdf',
                    displayOptions: {
                        show: {
                            fileSource: ['base64'],
                        },
                    },
                    description: 'MIME type of the file (e.g., application/pdf, image/png)',
                },
                {
                    displayName: 'Max Tokens',
                    name: 'maxTokens',
                    type: 'number',
                    default: 4096,
                    description: 'Maximum tokens in response',
                },
                {
                    displayName: 'Temperature',
                    name: 'temperature',
                    type: 'number',
                    default: 0.7,
                    typeOptions: {
                        minValue: 0,
                        maxValue: 1,
                        numberPrecision: 1,
                    },
                    description: 'Sampling temperature',
                },
            ],
            usableAsTool: true,
        };
    }
    async execute() {
        var _a, _b, _c, _d;
        const items = this.getInputData();
        const returnData = [];
        const credentials = await this.getCredentials('aws');
        const region = this.getNodeParameter('region', 0);
        const modelId = this.getNodeParameter('modelId', 0);
        const maxTokens = this.getNodeParameter('maxTokens', 0);
        const temperature = this.getNodeParameter('temperature', 0);
        const bedrockClient = new client_bedrock_runtime_1.BedrockRuntimeClient({
            region,
            credentials: {
                accessKeyId: credentials.accessKeyId,
                secretAccessKey: credentials.secretAccessKey,
            },
        });
        for (let i = 0; i < items.length; i++) {
            try {
                const message = this.getNodeParameter('message', i);
                const fileSource = this.getNodeParameter('fileSource', i);
                let fileBytes;
                let fileType;
                if (fileSource === 'binary') {
                    const binaryProperty = this.getNodeParameter('binaryProperty', i);
                    const binaryData = this.helpers.assertBinaryData(i, binaryProperty);
                    fileBytes = await this.helpers.getBinaryDataBuffer(i, binaryProperty);
                    fileType = binaryData.mimeType;
                }
                else {
                    const base64Content = this.getNodeParameter('base64Content', i);
                    fileType = this.getNodeParameter('fileType', i);
                    fileBytes = Buffer.from(base64Content, 'base64');
                }
                const content = [{ text: message }];
                if (fileType.startsWith('image/')) {
                    const format = fileType.split('/')[1];
                    content.push({
                        image: {
                            format: format,
                            source: {
                                bytes: fileBytes,
                            },
                        },
                    });
                }
                else if (fileType === 'application/pdf') {
                    content.push({
                        document: {
                            format: 'pdf',
                            name: 'document',
                            source: {
                                bytes: fileBytes,
                            },
                        },
                    });
                }
                const command = new client_bedrock_runtime_1.ConverseCommand({
                    modelId,
                    messages: [
                        {
                            role: 'user',
                            content,
                        },
                    ],
                    inferenceConfig: {
                        maxTokens,
                        temperature,
                        topP: 0.9,
                    },
                });
                const response = await bedrockClient.send(command);
                returnData.push({
                    json: {
                        response: ((_d = (_c = (_b = (_a = response.output) === null || _a === void 0 ? void 0 : _a.message) === null || _b === void 0 ? void 0 : _b.content) === null || _c === void 0 ? void 0 : _c[0]) === null || _d === void 0 ? void 0 : _d.text) || '',
                        usage: response.usage || {},
                        stopReason: response.stopReason,
                    },
                });
            }
            catch (error) {
                if (this.continueOnFail()) {
                    returnData.push({
                        json: {
                            error: error.message,
                        },
                    });
                    continue;
                }
                throw new n8n_workflow_1.NodeOperationError(this.getNode(), error);
            }
        }
        return [returnData];
    }
}
exports.BedrockDocumentProcessor = BedrockDocumentProcessor;
//# sourceMappingURL=BedrockDocumentProcessor.node.js.map