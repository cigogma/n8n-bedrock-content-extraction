import {
  IExecuteFunctions,
  INodeExecutionData,
  INodeType,
  INodeTypeDescription,
  NodeOperationError,
} from 'n8n-workflow';

import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';

export class BedrockDocumentProcessor implements INodeType {
  description: INodeTypeDescription = {
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

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const items = this.getInputData();
    const returnData: INodeExecutionData[] = [];

    // Get AWS credentials
    const credentials = await this.getCredentials('aws');
    
    const region = this.getNodeParameter('region', 0) as string;
    const modelId = this.getNodeParameter('modelId', 0) as string;
    const maxTokens = this.getNodeParameter('maxTokens', 0) as number;
    const temperature = this.getNodeParameter('temperature', 0) as number;

    // Initialize Bedrock client
    const bedrockClient = new BedrockRuntimeClient({
      region,
      credentials: {
        accessKeyId: credentials.accessKeyId as string,
        secretAccessKey: credentials.secretAccessKey as string,
      },
    });

    for (let i = 0; i < items.length; i++) {
      try {
        const message = this.getNodeParameter('message', i) as string;
        const fileSource = this.getNodeParameter('fileSource', i) as string;

        let fileBytes: Buffer;
        let fileType: string;

        if (fileSource === 'binary') {
          // Get from binary data
          const binaryProperty = this.getNodeParameter('binaryProperty', i) as string;
          const binaryData = this.helpers.assertBinaryData(i, binaryProperty);
          fileBytes = await this.helpers.getBinaryDataBuffer(i, binaryProperty);
          fileType = binaryData.mimeType;
        } else {
          // Get from base64 string
          const base64Content = this.getNodeParameter('base64Content', i) as string;
          fileType = this.getNodeParameter('fileType', i) as string;
          fileBytes = Buffer.from(base64Content, 'base64');
        }

        // Build content array
        const content: any[] = [{ text: message }];

        // Handle images
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
        // Handle PDF documents
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

        // Call Bedrock
        const command = new ConverseCommand({
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
            response: response.output?.message?.content?.[0]?.text || '',
            usage: response.usage || {},
            stopReason: response.stopReason,
          },
        });
      } catch (error) {
        if (this.continueOnFail()) {
          returnData.push({
            json: {
              error: error.message,
            },
          });
          continue;
        }
        throw new NodeOperationError(this.getNode(), error);
      }
    }

    return [returnData];
  }
}