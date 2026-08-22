import {
  BedrockRuntimeClient,
  ConverseCommand,
  ConverseStreamCommand,
  type ContentBlock,
  type ConverseCommandInput,
  type Message as BedrockMessage,
  type SystemContentBlock,
} from '@aws-sdk/client-bedrock-runtime';
import { BedrockClient, ListFoundationModelsCommand } from '@aws-sdk/client-bedrock';
import { z } from 'zod';
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import { LlmProviderBase } from './LlmProviderBase';
import { ImageContent, LlmContent, LlmGenerationOptions, LlmGenerationResult, LlmMessage, TextContent } from './ILlmProvider';
import { logger } from '../../../utils/logger';
import type { LlmModelInfo } from '../ProviderCatalogService';

extendZodWithOpenApi(z);

/**
 * Schema for Amazon Bedrock provider configuration.
 *
 * Credentials are optional: when `accessKeyId`/`secretAccessKey` are omitted the
 * AWS SDK default credential provider chain is used, which lets the backend run
 * with an IAM role (ECS task role, EKS service account, EC2 instance profile)
 * instead of long-lived keys.
 */
export const bedrockLlmProviderConfigSchema = z.strictObject({
  region: z.string().describe('AWS region hosting the Bedrock endpoint (e.g., "us-east-1", "eu-central-1")'),
  accessKeyId: z.string().optional().describe('AWS access key ID. Omit to use the default credential provider chain (IAM role, instance profile, environment)'),
  secretAccessKey: z.string().optional().describe('AWS secret access key. Omit to use the default credential provider chain'),
  sessionToken: z.string().optional().describe('AWS session token, when using temporary credentials'),
});

export type BedrockLlmProviderConfig = z.infer<typeof bedrockLlmProviderConfigSchema>;

/**
 * Schema for Amazon Bedrock LLM settings.
 *
 * Uses the Bedrock Converse API, which normalises requests and responses across
 * every Bedrock model family, so the same settings apply to Anthropic Claude,
 * Meta Llama, Mistral, Amazon Nova and others.
 */
export const bedrockLlmSettingsSchema = z.object({
  model: z.string().min(1).describe('Bedrock model ID or inference profile ID (e.g., "us.anthropic.claude-sonnet-4-5-20250929-v1:0"). Many newer models are only reachable through a regional inference profile, which is the model ID prefixed with "us.", "eu." or "apac."'),
  defaultMaxTokens: z.number().int().positive().optional().describe('Default maximum tokens for generation'),
  defaultTemperature: z.number().min(0).max(1).optional().describe('Default temperature for generation (0-1)'),
  defaultTopP: z.number().min(0).max(1).optional().describe('Default top-p for generation (0-1)'),

  reasoningBudgetTokens: z.number().int().min(1024).optional().describe('Enable extended reasoning with this token budget (min: 1024). Only supported by reasoning-capable models such as Claude 4.x. Temperature and top-p are ignored when set.'),

  guardrailIdentifier: z.string().optional().describe('Bedrock Guardrail ID to apply to every request'),
  guardrailVersion: z.string().optional().describe('Bedrock Guardrail version. Required when guardrailIdentifier is set'),

  timeout: z.number().int().positive().optional().describe('Request timeout in milliseconds'),
}).openapi('BedrockLlmSettings');

export type BedrockLlmSettings = z.infer<typeof bedrockLlmSettingsSchema>;

/**
 * Amazon Bedrock LLM provider.
 *
 * Built on the Converse API rather than InvokeModel so that a single
 * implementation covers every Bedrock model family with one request and
 * response shape, including streaming, system prompts, vision and token usage.
 */
export class BedrockLlmProvider extends LlmProviderBase<BedrockLlmProviderConfig> {
  private client?: BedrockRuntimeClient;
  private settings: BedrockLlmSettings;

  constructor(config: BedrockLlmProviderConfig, settings: BedrockLlmSettings) {
    super(config);
    this.settings = settings;
  }

  /**
   * Initialize the Bedrock runtime client
   */
  async init(): Promise<void> {
    await super.init();

    this.client = new BedrockRuntimeClient({
      region: this.config!.region,
      // Omitting `credentials` entirely lets the SDK fall back to its default
      // provider chain, which is what we want when running under an IAM role.
      ...(this.config!.accessKeyId && this.config!.secretAccessKey
        ? {
            credentials: {
              accessKeyId: this.config!.accessKeyId,
              secretAccessKey: this.config!.secretAccessKey,
              sessionToken: this.config!.sessionToken,
            },
          }
        : {}),
      ...(this.settings.timeout ? { requestHandler: { requestTimeout: this.settings.timeout } } : {}),
    });

    logger.info(`Bedrock LLM provider initialized with model: ${this.settings.model} in ${this.config!.region}`);
  }

  /**
   * Generate a non-streaming response
   */
  async generate(messages: LlmMessage[], options?: LlmGenerationOptions): Promise<LlmGenerationResult> {
    this.ensureInitialized();
    this.validateMessages(messages);

    if (!this.client) {
      throw new Error('Bedrock client not initialized');
    }

    const outputFormat = options?.outputFormat || 'text';
    if (outputFormat !== 'text' && outputFormat !== 'json') {
      throw new Error(`Unsupported output format: ${outputFormat}`);
    }

    await this.notifyStarted();

    try {
      logger.info(`Generating Bedrock completion with model: ${this.settings.model}`);

      const response = await this.client.send(new ConverseCommand(this.buildRequest(messages, options)));

      let content = '';
      for (const block of response.output?.message?.content ?? []) {
        if (block.text) {
          content += block.text;
        }
      }

      if (outputFormat === 'json') {
        try {
          JSON.parse(content);
        } catch (error) {
          logger.error(`Failed to parse JSON output: ${error instanceof Error ? error.message : String(error)}`);
          throw new Error('Failed to parse JSON output from model response');
        }
      }

      const contentArray: LlmContent[] = [
        {
          contentType: 'text',
          text: content,
        },
      ];

      const result: LlmGenerationResult = {
        id: response.$metadata?.requestId ?? '',
        content: contentArray,
        role: 'assistant',
        finishReason: this.mapStopReason(response.stopReason),
        usage: {
          promptTokens: response.usage?.inputTokens ?? 0,
          completionTokens: response.usage?.outputTokens ?? 0,
          totalTokens: response.usage?.totalTokens ?? 0,
        },
        metadata: {
          model: this.settings.model,
          stopReason: response.stopReason,
          latencyMs: response.metrics?.latencyMs,
        },
      };

      await this.notifyComplete(result);
      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`Bedrock generation error: ${errorMessage}`);
      await this.notifyError(error instanceof Error ? error : new Error(errorMessage));
      throw error;
    }
  }

  /**
   * Generate a streaming response
   */
  async generateStream(messages: LlmMessage[], options?: LlmGenerationOptions): Promise<void> {
    this.ensureInitialized();
    this.validateMessages(messages);

    if (!this.client) {
      throw new Error('Bedrock client not initialized');
    }

    if (options?.outputFormat && options.outputFormat !== 'text') {
      throw new Error(`Output format ${options.outputFormat} not supported for streaming generation`);
    }

    try {
      logger.info(`Starting Bedrock streaming completion with model: ${this.settings.model}`);

      const response = await this.client.send(new ConverseStreamCommand(this.buildRequest(messages, options)));

      let fullContent = '';
      let finalStopReason: string | undefined;
      let inputTokens = 0;
      let outputTokens = 0;
      const messageId = response.$metadata?.requestId ?? '';

      for await (const event of response.stream ?? []) {
        const delta = event.contentBlockDelta?.delta?.text;
        if (delta) {
          fullContent += delta;
          await this.notifyChunk(delta, messageId, 'assistant', null);
          continue;
        }

        if (event.messageStop?.stopReason) {
          finalStopReason = event.messageStop.stopReason;
          continue;
        }

        if (event.metadata?.usage) {
          inputTokens = event.metadata.usage.inputTokens ?? inputTokens;
          outputTokens = event.metadata.usage.outputTokens ?? outputTokens;
        }
      }

      const contentArray: LlmContent[] = [
        {
          contentType: 'text',
          text: fullContent,
        },
      ];

      const result: LlmGenerationResult = {
        id: messageId,
        content: contentArray,
        role: 'assistant',
        finishReason: this.mapStopReason(finalStopReason),
        usage: {
          promptTokens: inputTokens,
          completionTokens: outputTokens,
          totalTokens: inputTokens + outputTokens,
        },
        metadata: {
          model: this.settings.model,
          stopReason: finalStopReason,
        },
      };

      await this.notifyComplete(result);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`Bedrock streaming error: ${errorMessage}`);
      await this.notifyError(error instanceof Error ? error : new Error(errorMessage));
      throw error;
    }
  }

  /**
   * Enumerate the text models the account can actually reach in this region.
   * Falls back to a static list when the caller lacks `bedrock:ListFoundationModels`.
   */
  async enumerateModels(): Promise<LlmModelInfo[]> {
    try {
      const control = new BedrockClient({
        region: this.config!.region,
        ...(this.config!.accessKeyId && this.config!.secretAccessKey
          ? {
              credentials: {
                accessKeyId: this.config!.accessKeyId,
                secretAccessKey: this.config!.secretAccessKey,
                sessionToken: this.config!.sessionToken,
              },
            }
          : {}),
      });

      const response = await control.send(new ListFoundationModelsCommand({ byOutputModality: 'TEXT' }));
      const models = (response.modelSummaries ?? [])
        .filter(m => m.modelId && m.responseStreamingSupported !== false)
        .map(m => BedrockLlmProvider.mapModelToInfo(m.modelId!, m.modelName, m.inputModalities));

      if (models.length > 0) {
        return models;
      }
    } catch (error) {
      logger.warn(`Failed to enumerate Bedrock models via API: ${error instanceof Error ? error.message : String(error)}, using static list`);
    }

    return BedrockLlmProvider.getStaticModels();
  }

  private static mapModelToInfo(modelId: string, modelName?: string, inputModalities?: string[]): LlmModelInfo {
    const supportsVision = (inputModalities ?? []).includes('IMAGE');
    const supportsReasoning = /claude-(?:opus|sonnet|haiku)-[4-9]/.test(modelId) || /deepseek-r1/.test(modelId);
    return {
      id: modelId,
      displayName: modelName ? `${modelName} (${modelId})` : modelId,
      supportsToolCalling: true,
      supportsJsonOutput: true,
      supportsStreaming: true,
      supportsVision,
      supportsReasoning,
    };
  }

  /**
   * Conservative fallback list. Bedrock model IDs are region- and
   * account-dependent, and most current models require a regional inference
   * profile prefix ("us.", "eu.", "apac."), so `enumerateModels()` is
   * authoritative whenever the API is reachable.
   */
  private static getStaticModels(): LlmModelInfo[] {
    return [
      { id: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0', displayName: 'Claude Sonnet 4.5 (inference profile)', recommended: true, description: 'Balanced speed and intelligence, with extended reasoning', supportsToolCalling: true, supportsJsonOutput: true, supportsStreaming: true, supportsVision: true, supportsReasoning: true, contextWindow: 200000 },
      { id: 'us.anthropic.claude-haiku-4-5-20251001-v1:0', displayName: 'Claude Haiku 4.5 (inference profile)', description: 'Fastest Claude model — a good fit for low-latency voice turns', supportsToolCalling: true, supportsJsonOutput: true, supportsStreaming: true, supportsVision: true, supportsReasoning: true, contextWindow: 200000 },
      { id: 'us.amazon.nova-pro-v1:0', displayName: 'Amazon Nova Pro', supportsToolCalling: true, supportsJsonOutput: true, supportsStreaming: true, supportsVision: true, supportsReasoning: false, contextWindow: 300000 },
      { id: 'us.amazon.nova-lite-v1:0', displayName: 'Amazon Nova Lite', supportsToolCalling: true, supportsJsonOutput: true, supportsStreaming: true, supportsVision: true, supportsReasoning: false, contextWindow: 300000 },
      { id: 'us.meta.llama3-3-70b-instruct-v1:0', displayName: 'Llama 3.3 70B Instruct', supportsToolCalling: true, supportsJsonOutput: true, supportsStreaming: true, supportsVision: false, supportsReasoning: false, contextWindow: 128000 },
    ];
  }

  /**
   * Build a Converse request shared by the streaming and non-streaming paths
   */
  private buildRequest(messages: LlmMessage[], options?: LlmGenerationOptions): ConverseCommandInput {
    const { system, messages: bedrockMessages } = this.convertToBedrockMessages(messages);

    const reasoning = this.settings.reasoningBudgetTokens;

    return {
      modelId: this.settings.model,
      messages: bedrockMessages,
      ...(system.length > 0 ? { system } : {}),
      inferenceConfig: {
        maxTokens: options?.maxTokens ?? this.settings.defaultMaxTokens ?? 4096,
        // Bedrock rejects temperature/top-p when reasoning is enabled.
        ...(reasoning ? {} : { temperature: this.settings.defaultTemperature, topP: this.settings.defaultTopP }),
      },
      ...(reasoning
        ? { additionalModelRequestFields: { reasoning_config: { type: 'enabled', budget_tokens: reasoning } } }
        : {}),
      ...(this.settings.guardrailIdentifier && this.settings.guardrailVersion
        ? {
            guardrailConfig: {
              guardrailIdentifier: this.settings.guardrailIdentifier,
              guardrailVersion: this.settings.guardrailVersion,
            },
          }
        : {}),
    };
  }

  /**
   * Convert our message format to the Converse API format.
   * Like Anthropic's native API, Converse keeps the system prompt separate from
   * the message list and requires strictly alternating user/assistant turns.
   */
  private convertToBedrockMessages(messages: LlmMessage[]): { system: SystemContentBlock[]; messages: BedrockMessage[] } {
    const system: SystemContentBlock[] = [];
    const bedrockMessages: BedrockMessage[] = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        const systemContent = typeof msg.content === 'string' ? msg.content : this.extractTextContent([msg]);
        system.push({ text: systemContent });
        continue;
      }

      // Converse models tool results as a dedicated content block; plain tool
      // messages have no equivalent, so they are skipped as they are elsewhere.
      if (msg.role === 'tool') {
        continue;
      }

      const role = msg.role === 'user' ? 'user' : 'assistant';

      if (typeof msg.content === 'string') {
        bedrockMessages.push({ role, content: [{ text: msg.content }] });
        continue;
      }

      const contentBlocks: ContentBlock[] = [];

      for (const content of msg.content) {
        if (content.type === 'text') {
          contentBlocks.push({ text: (content as TextContent).text });
        } else if (content.type === 'image') {
          const imageContent = content as ImageContent;
          if (imageContent.source.type === 'url') {
            logger.warn('Bedrock Converse does not support image URLs directly. Image will be skipped.');
            continue;
          }
          if (imageContent.source.type === 'base64' && imageContent.source.data) {
            contentBlocks.push({
              image: {
                format: BedrockLlmProvider.getBedrockImageFormat(imageContent.source.mimeType),
                source: { bytes: Buffer.from(imageContent.source.data, 'base64') },
              },
            });
          }
        } else if (content.type === 'json') {
          contentBlocks.push({ text: JSON.stringify((content as any).data) });
        }
      }

      if (contentBlocks.length > 0) {
        bedrockMessages.push({ role, content: contentBlocks });
      }
    }

    return { system, messages: bedrockMessages };
  }

  /**
   * Map a MIME type to the image format Converse expects
   */
  private static getBedrockImageFormat(mimeType?: string): 'png' | 'jpeg' | 'gif' | 'webp' {
    switch (mimeType) {
      case 'image/png':
        return 'png';
      case 'image/gif':
        return 'gif';
      case 'image/webp':
        return 'webp';
      case 'image/jpeg':
      case 'image/jpg':
      default:
        return 'jpeg';
    }
  }

  /**
   * Map Bedrock's stop reason to our finish reason format
   */
  private mapStopReason(reason?: string): 'stop' | 'length' | 'tool_calls' | 'content_filter' {
    switch (reason) {
      case 'end_turn':
      case 'stop_sequence':
        return 'stop';
      case 'max_tokens':
        return 'length';
      case 'tool_use':
        return 'tool_calls';
      case 'content_filtered':
      case 'guardrail_intervened':
        return 'content_filter';
      default:
        return 'stop';
    }
  }
}
