import { OpenRouter } from '@openrouter/sdk';
import { config } from '../../config';
import Logger from '../../common/logger';
import fs from 'fs';

const logger = new Logger('OpenRouterService');

export interface ResponseSchema {
    answer: string;
    confidence: number;
}

export type CommentType = any;

export interface ClassificationSchema {
    type: CommentType;
    reason: string;
}

const CLASSIFICATION_SCHEMA = {
    type: 'object',
    properties: {
        type: {
            type: 'string',
            enum: [],
            description: 'The trade classification'
        },
        reason: {
            type: 'string',
            description: 'Brief reason for the classification'
        }
    },
    required: ['type', 'reason'],
    additionalProperties: false
};

class OpenRouterService {
    private client: OpenRouter;
    private fastModel = config.openRouter.fastModel;
    private classificationPromptTemplate;

    constructor() {
        this.client = new OpenRouter({
            apiKey: config.openRouter.apiKey
        });
        this.classificationPromptTemplate = fs.readFileSync(config.openRouter.classifierPromptTemplatePath, 'utf-8');
    }

    async classifyTrade(data: string): Promise<ClassificationSchema> {
        try {
            const result = await this.client.chat.send({
                chatGenerationParams: {
                    responseFormat: {
                        type: 'json_schema',
                        jsonSchema: {
                            name: 'comment_classification',
                            strict: true,
                            schema: CLASSIFICATION_SCHEMA
                        }
                    },
                    messages: [
                        {
                            role: 'user',
                            content: this.classificationPromptTemplate.replace('{data}', data)
                        }
                    ],
                    model: this.fastModel,
                    stream: false
                }
            });

            const rawContent = result.choices[0].message?.content;
            if (typeof rawContent !== 'string') throw new Error('Invalid response format');

            const classification = JSON.parse(rawContent) as ClassificationSchema;
            logger.info(`Received classification response: ${classification.type}`);
            return classification;
        } catch (error) {
            throw new Error(`Failed to classify trade: ${error}`);
        }
    }
}

export default new OpenRouterService();
