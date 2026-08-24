import { z, type ZodType } from 'zod';
import type { ErrorCallback, SimpleCallback } from '../../../types/callbacks';
import { ILlmProvider, LlmChunkCallback, LlmCompleteCallback, LlmGenerationOptions, LlmGenerationResult, LlmMessage, StructuredGenerationResult, StructuredOutputError, StructuredOutputSupport } from './ILlmProvider';
import { parseJsonFromMarkdown } from '../../../utils/jsonParser';
import { extractTextFromContent } from '../../../utils/llm';
import { logger } from '../../../utils/logger';
import { log } from 'handlebars';
import { LlmModelInfo } from '../ProviderCatalogService';

/**
 * Derive a JSON Schema from a Zod schema, for providers that enforce one.
 *
 * A derived schema is a fallback, not the preferred path: it mirrors every branch of
 * the Zod type, which for a permissive union runs to hundreds of tokens on every
 * turn. Callers with a hot loop should hand `options.schema` a compact schema of
 * their own and let the Zod type do the precise validation afterwards.
 */
export function toJsonSchema(validator: ZodType<unknown>): Record<string, unknown> {
  try {
    const { $schema, ...schema } = z.toJSONSchema(validator as any, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
    return schema;
  } catch (error) {
    logger.warn(`Could not derive a JSON Schema, falling back to an unconstrained object: ${error instanceof Error ? error.message : String(error)}`);
    return { type: 'object' };
  }
}

/**
 * Parse the JSON a model meant to send, from the text it actually sent.
 *
 * Beyond the code fences `parseJsonFromMarkdown` already strips, this recovers the
 * case where a model prefaces the object with a sentence. It is only ever reached on
 * the unconstrained rung; a provider that enforces a schema never needs it.
 */
function parseStructuredText(text: string): unknown {
  try {
    return parseJsonFromMarkdown(text);
  } catch (error) {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end <= start) {
      throw error;
    }
    return JSON.parse(text.slice(start, end + 1));
  }
}

/**
 * Abstract base class for LLM provider implementations
 * Provides common functionality for callback management, lifecycle, and error handling
 */
export abstract class LlmProviderBase<TConfig> implements ILlmProvider {
  protected config?: TConfig;
  protected initialized: boolean = false;
  protected onChunkCallback?: LlmChunkCallback;
  protected onGenerationCompletedCallback?: LlmCompleteCallback;
  protected onGenerationStartedCallback?: SimpleCallback;
  protected onErrorCallback?: ErrorCallback;

  constructor(config: TConfig) {
    this.config = config;
  }

  /**
   * Initialize the provider with configuration
   * Subclasses should override this and call super.init() first
   */
  async init(): Promise<void> {
    logger.info('Initializing LLM provider...');
    this.initialized = true;
  }

  /**
   * Generate a non-streaming response
   * Must be implemented by subclasses
   */
  abstract generate(messages: LlmMessage[], options?: LlmGenerationOptions): Promise<LlmGenerationResult>;

  /**
   * Generate a streaming response
   * Must be implemented by subclasses
   */
  abstract generateStream(messages: LlmMessage[], options?: LlmGenerationOptions): Promise<void>;

  /**
   * How strongly this provider can constrain the shape of its output.
   *
   * 'none' by default so that every provider compiles and behaves exactly as it did
   * before this existed. A provider opts in deliberately, by overriding this and
   * honouring `options.schema` in `generate`.
   */
  structuredOutput(): StructuredOutputSupport {
    return 'none';
  }

  /**
   * Generate a value that satisfies `validator`, or throw.
   *
   * The ladder, climbed once here rather than at each call site:
   *
   *   tool  the API enforces the shape. One attempt is enough, because a second
   *         could not do better.
   *   json  the API guarantees valid JSON but not the requested shape, so a shape
   *         failure is still possible and still worth one retry.
   *   none  prose. Parse it, and on failure retry ONCE with the parse error handed
   *         back to the model. One retry converts most single-shot formatting
   *         slips; a second failure is a real failure rather than a coin toss.
   *
   * A tool-capable provider that rejects the request outright - a model family whose
   * Bedrock profile has no forced tool use, say - falls back to the JSON rung rather
   * than failing the caller. A live phone call should not end over a request shape.
   *
   * Whatever happens, the outcome is a validated value or a StructuredOutputError.
   * There is deliberately no third outcome that a caller could read as "no action".
   */
  async generateStructured<T>(messages: LlmMessage[], validator: ZodType<T>, options?: LlmGenerationOptions): Promise<StructuredGenerationResult<T>> {
    const support = this.structuredOutput();

    if (support === 'tool') {
      const schema = options?.schema ?? toJsonSchema(validator);
      try {
        const raw = await this.generate(messages, { ...options, schema, outputFormat: 'json' });
        return { value: validator.parse(parseStructuredText(extractTextFromContent(raw.content))), raw, mode: 'tool', attempts: 1 };
      } catch (error) {
        logger.warn(`Constrained generation failed, falling back to JSON output: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    // Both remaining rungs parse prose; they differ only in whether the API promised
    // the text would be JSON at all.
    const mode: StructuredOutputSupport = support === 'json' ? 'json' : 'none';
    const baseOptions: LlmGenerationOptions = { ...options, schema: undefined, ...(mode === 'json' ? { outputFormat: 'json' as const } : {}) };

    let lastText = '';
    let lastError: unknown;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const attemptMessages = attempt === 1 ? messages : [
        ...messages,
        { role: 'assistant' as const, content: lastText || '(empty response)' },
        { role: 'user' as const, content: `That response could not be used: ${lastError instanceof Error ? lastError.message : String(lastError)}. Reply with the JSON object only - no prose, no explanation, no code fences.` },
      ];

      try {
        const raw = await this.generate(attemptMessages, baseOptions);
        lastText = extractTextFromContent(raw.content);
        return { value: validator.parse(parseStructuredText(lastText)), raw, mode, attempts: attempt };
      } catch (error) {
        lastError = error;
        logger.warn(`Structured generation attempt ${attempt} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    throw new StructuredOutputError(
      `Could not obtain schema-valid output after 2 attempts (mode: ${mode}): ${lastError instanceof Error ? lastError.message : String(lastError)}`,
      lastText,
      lastError,
    );
  }

  /**
   * Set callback for streaming chunks
   */
  setOnChunk(callback: LlmChunkCallback): void {
    this.onChunkCallback = callback;
  }

  /**
   * Set callback for generation completion
   */
  setOnGenerationCompleted(callback: LlmCompleteCallback): void {
    this.onGenerationCompletedCallback = callback;
  }

  /**
   * Set callback for when provider is ready
   */
  setOnGenerationStarted(callback: SimpleCallback): void {
    this.onGenerationStartedCallback = callback;
  }

  /**
   * Set callback for fatal errors
   */
  setOnError(callback: ErrorCallback): void {
    this.onErrorCallback = callback;
  }

  /**
   * Get the current configuration
   */
  getConfig(): TConfig {
    if (!this.config) {
      throw new Error('Provider not initialized - config is undefined');
    }
    return this.config;
  }

  /**
   * Check if provider is initialized
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Notify that provider is ready
   */
  protected async notifyStarted(): Promise<void> {
    if (this.onGenerationStartedCallback) {
      try {
        await this.onGenerationStartedCallback();
      } catch (error) {
        logger.error(`Error in generation started callback: ${error}`);
      }
    }
  }

  /**
   * Notify about a streaming chunk
   */
  protected async notifyChunk(content: string, id: string, role?: 'assistant', finishReason?: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null, usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number }): Promise<void> {
    if (this.onChunkCallback) {
      try {
        await this.onChunkCallback({ id, content, role, finishReason, usage });
      } catch (error) {
        logger.error(`Error in chunk callback: ${error}`);
      }
    }
  }

  /**
   * Notify about generation completion
   */
  protected async notifyComplete(result: LlmGenerationResult): Promise<void> {
    if (this.onGenerationCompletedCallback) {
      try {
        await this.onGenerationCompletedCallback(result);
      } catch (error) {
        logger.error(`Error in generation completed callback: ${error}`);
      }
    }
  }

  /**
   * Notify about a fatal error
   */
  protected async notifyError(error: Error): Promise<void> {
    logger.error(`LLM provider fatal error: ${error.message}`);
    if (this.onErrorCallback) {
      try {
        await this.onErrorCallback(error);
      } catch (callbackError) {
        logger.error(`Error in error callback: ${callbackError}`);
      }
    }
  }

  /**
   * Releases all resources held by the provider.
   * Subclasses can override this to perform provider-specific cleanup.
   */
  async cleanup(): Promise<void> {
    this.onChunkCallback = undefined;
    this.onGenerationCompletedCallback = undefined;
    this.onGenerationStartedCallback = undefined;
    this.onErrorCallback = undefined;
  }

  /**
   * Ensure provider is initialized before operations
   */
  protected ensureInitialized(): void {
    if (!this.initialized || !this.config) {
      throw new Error('Provider must be initialized before use');
    }
  }

  /**
   * Apply default options from config
   */
  protected applyDefaultOptions(options?: LlmGenerationOptions): LlmGenerationOptions {
    return {
      maxTokens: options?.maxTokens ?? 1024,
      metadata: options?.metadata,
      outputFormat: options?.outputFormat ?? 'text',
    };
  }

  /**
   * Validate messages before sending to provider
   */
  protected validateMessages(messages: LlmMessage[]): void {
    if (!messages || messages.length === 0) {
      throw new Error('Messages array cannot be empty');
    }

    if (messages[0].role !== 'system') {
      throw new Error('First message must have role "system"');
    }

    for (const message of messages) {
      if (!message.role) {
        throw new Error('Message role is required');
      }
      if (!message.content || (typeof message.content === 'string' && message.content.length === 0) || (Array.isArray(message.content) && message.content.length === 0)) {
        throw new Error('Message content cannot be empty');
      }
    }
  }

  /**
   * Extract text content from message (helper for simple text extraction)
   */
  protected extractTextContent(messages: LlmMessage[]): string {
    return messages.map((msg) => {
      if (typeof msg.content === 'string') {
        return msg.content;
      }
      return msg.content.filter((c) => c.type === 'text').map((c) => (c as any).text).join(' ');
    }).join('\n');
  }

  /**
   * Enumerate available models from the provider, returning an array of model information.
   * Must be implemented by subclasses to return provider-specific model details.
   */
   abstract enumerateModels(): Promise<LlmModelInfo[]>;

    /**
     * Moderate user input for content policy violations. Returns whether the input was flagged and any applicable categories.
     * By default, this method throws an error indicating that moderation is not supported. Subclasses can override this to provide actual moderation functionality if supported by the provider.
     * @param input User input to moderate
     * @returns Object containing flagged status and categories of violation
     */
    async moderateUserInput(input: string): Promise<{ flagged: boolean; categories: string[]; }> {
     throw new Error('Moderation is not supported by this provider');
   }
}
