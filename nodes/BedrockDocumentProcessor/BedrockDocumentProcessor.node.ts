import {
  IExecuteFunctions,
  INodeExecutionData,
  INodeType,
  INodeTypeDescription,
  NodeOperationError,
} from 'n8n-workflow';

import { randomUUID } from 'crypto';
import {
  TextractClient,
  DetectDocumentTextCommand,
  StartDocumentTextDetectionCommand,
  GetDocumentTextDetectionCommand,
} from '@aws-sdk/client-textract';
import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';

export class AmazonTextractOCR implements INodeType {
  description: INodeTypeDescription = {
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

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const items = this.getInputData();
    const returnData: INodeExecutionData[] = [];

    // Credentials and region
    const credentials = (await this.getCredentials('aws')) as {
      accessKeyId?: string;
      secretAccessKey?: string;
      region?: string;
    };

    if (!credentials || !credentials.accessKeyId || !credentials.secretAccessKey) {
      throw new NodeOperationError(this.getNode(), 'AWS credentials are missing or incomplete');
    }

    // Per-node configuration
    const s3Bucket = this.getNodeParameter('s3Bucket', 0) as string;
    const s3Prefix = (this.getNodeParameter('s3Prefix', 0) as string) || '';
    const timeoutSeconds = this.getNodeParameter('timeoutSeconds', 0) as number;

    if (!s3Bucket) {
      throw new NodeOperationError(this.getNode(), 'S3 bucket must be provided');
    }

    // Determine region: prefer credential region, otherwise fallback to environ or sdk default
    const region = credentials.region || (this.getNodeParameter('region', 0) as string) || undefined;

    const s3Client = new S3Client({
      region,
      credentials: {
        accessKeyId: credentials.accessKeyId as string,
        secretAccessKey: credentials.secretAccessKey as string,
      },
    });

    const textractClient = new TextractClient({
      region,
      credentials: {
        accessKeyId: credentials.accessKeyId as string,
        secretAccessKey: credentials.secretAccessKey as string,
      },
    });

    for (let i = 0; i < items.length; i++) {
      let uploadedKey: string | undefined;
      try {
        const fileSource = this.getNodeParameter('fileSource', i) as string;

        let fileBuffer: Buffer;
        let fileType: string;

        if (fileSource === 'binary') {
          const binaryProperty = this.getNodeParameter('binaryProperty', i) as string;
          const binaryData = this.helpers.assertBinaryData(i, binaryProperty);
          fileBuffer = await this.helpers.getBinaryDataBuffer(i, binaryProperty);
          fileType = binaryData.mimeType;
        } else {
          const base64Content = this.getNodeParameter('base64Content', i) as string;
          fileType = this.getNodeParameter('fileType', i) as string;
          fileBuffer = Buffer.from(base64Content, 'base64');
        }

        const isPdf = fileType === 'application/pdf';
        const isImage = fileType.startsWith('image/');

        if (!isPdf && !isImage) {
          throw new NodeOperationError(this.getNode(), `Unsupported MIME type: ${fileType}`);
        }

        let extractedText = '';

        if (isImage) {
          // Synchronous call with bytes for images
          const detectCmd = new DetectDocumentTextCommand({
            Document: { Bytes: fileBuffer },
          });
          const resp = await textractClient.send(detectCmd);
          const blocks = resp.Blocks ?? [];
          const lines: string[] = [];
          for (const b of blocks) {
            const bt = (b as any).BlockType as string | undefined;
            const txt = (b as any).Text ?? (b as any).DetectedText ?? '';
            if (bt === 'LINE' && txt) lines.push(txt);
          }
          extractedText = lines.join('\n');
        } else {
          // PDF: upload to S3, start async job, poll synchronously, then fetch results
          const key = `${s3Prefix}${s3Prefix && !s3Prefix.endsWith('/') ? '/' : ''}${Date.now()}-${randomUUID()}.pdf`;
          uploadedKey = key;

          await s3Client.send(
            new PutObjectCommand({ Bucket: s3Bucket, Key: key, Body: fileBuffer, ContentType: fileType }),
          );

          const startCmd = new StartDocumentTextDetectionCommand({
            DocumentLocation: { S3Object: { Bucket: s3Bucket, Name: key } },
          });
          const startResp = await textractClient.send(startCmd);
          const jobId = startResp.JobId;
          if (!jobId) throw new NodeOperationError(this.getNode(), 'Failed to start Textract job');

          const startTime = Date.now();
          const timeoutAt = startTime + (timeoutSeconds || 120) * 1000;

          // Poll for job completion
          let jobStatus: string | undefined;
          let getResp: any = null;
          while (Date.now() < timeoutAt) {
            await new Promise((res) => setTimeout(res, 3000));
            getResp = await textractClient.send(new GetDocumentTextDetectionCommand({ JobId: jobId }));
            jobStatus = getResp.JobStatus as string | undefined;
            if (jobStatus === 'SUCCEEDED' || jobStatus === 'FAILED') break;
          }

          if (jobStatus !== 'SUCCEEDED') {
            throw new NodeOperationError(this.getNode(), `Textract job did not complete successfully: ${jobStatus}`);
          }

          // collect all pages
          const allBlocks: any[] = [];
          let nextToken = getResp.NextToken as string | undefined;
          allBlocks.push(...(getResp.Blocks ?? []));
          while (nextToken) {
            const pageResp = await textractClient.send(new GetDocumentTextDetectionCommand({ JobId: jobId, NextToken: nextToken }));
            allBlocks.push(...(pageResp.Blocks ?? []));
            nextToken = (pageResp.NextToken as string) || undefined;
          }

          const lines: string[] = [];
          for (const b of allBlocks) {
            const bt = (b as any).BlockType as string | undefined;
            const txt = (b as any).Text ?? (b as any).DetectedText ?? '';
            if (bt === 'LINE' && txt) lines.push(txt);
          }
          extractedText = lines.join('\n');
        }

        returnData.push({ json: { text: extractedText } });
      } catch (error) {
        const errMsg = (error as any)?.message ?? String(error);
        if (this.continueOnFail()) {
          returnData.push({ json: { error: errMsg } });
          continue;
        }
        throw new NodeOperationError(this.getNode(), errMsg);
      } finally {
        // Cleanup uploaded S3 object if present
        if (uploadedKey) {
          try {
            await s3Client.send(new DeleteObjectCommand({ Bucket: s3Bucket, Key: uploadedKey }));
          } catch (e) {
            // don't fail the node for cleanup errors; log to output if continueOnFail
            if (this.continueOnFail()) {
              returnData.push({ json: { warning: `Failed to delete S3 object ${uploadedKey}: ${(e as any)?.message ?? e}` } });
            }
          }
        }
      }
    }

    return [returnData];
  }
}