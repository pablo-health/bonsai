import { z, type ZodType } from 'zod';
import type { ErrorCallback, SimpleCallback } from '../../../types/callbacks';
import { LlmModelInfo } from '../ProviderCatalogService';

/**
 * Represents the role of a message in a conversation
 */
export const messageRoleSchema = z.enum(['system', 'user', 'assistant', 'tool']);
export type MessageRole = z.infer<typeof messageRoleSchema>;

/**
 * Content type for multi-modal messages
 */
export const messageContentTypeSchema = z.enum(['text', 'image', 'json']);
export type MessageContentType = z.infer<typeof messageContentTypeSchema>;

/**
 * Text content block
 */
export const textContentSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
});
export type TextContent = z.infer<typeof textContentSchema>;

/**
 * Image content block with support for URLs or base64 data
 */
export const imageContentSchema = z.object({
  type: z.literal('image'),
  source: z.object({
    type: z.enum(['url', 'base64']),
    url: z.string().optional(),
    data: z.string().optional(),
    mimeType: z.string().optional(),
  }),
});
export type ImageContent = z.infer<typeof imageContentSchema>;

/**
 * JSON content block for structured data
 */
export const jsonContentSchema = z.object({
  type: z.literal('json'),
  data: z.record(z.string(), z.any()),
});
export type JsonContent = z.infer<typeof jsonContentSchema>;

/**
 * Multi-modal message content
 */
export const messageContentSchema = z.discriminatedUnion('type', [
  textContentSchema,
  imageContentSchema,
  jsonContentSchema,
]);
export type MessageContent = z.infer<typeof messageContentSchema>;

/**
 * Message in conversation history
 */
export const llmMessageSchema = z.object({
  role: messageRoleSchema,
  content: z.union([z.string(), z.array(messageContentSchema)]),
  name: z.string().optional(),
  toolCallId: z.string().optional(),
});
export type LlmMessage = z.infer<typeof llmMessageSchema>;

/**
 * Token usage information for generation
 */
export const tokenUsageSchema = z.object({
  promptTokens: z.number(),
  completionTokens: z.number(),
  totalTokens: z.number(),
});
export type TokenUsage = z.infer<typeof tokenUsageSchema>;

/**
 * Text content in LLM output
 */
export const llmTextContentSchema = z.object({
  contentType: z.literal('text'),
  text: z.string(),
});
export type LlmTextContent = z.infer<typeof llmTextContentSchema>;

/**
 * Image content in LLM output
 */
export const llmImageContentSchema = z.object({
  contentType: z.literal('image'),
  data: z.string().describe('Base64-encoded image data'),
  mimeType: z.string().describe('MIME type (e.g., image/png, image/jpeg)'),
  metadata: z.object({
    width: z.number().optional(),
    height: z.number().optional(),
  }).catchall(z.any()).optional(),
});
export type LlmImageContent = z.infer<typeof llmImageContentSchema>;

/**
 * Audio content in LLM output
 */
export const llmAudioContentSchema = z.object({
  contentType: z.literal('audio'),
  data: z.string().describe('Base64-encoded audio data'),
  format: z.enum(['pcm', 'mp3', 'wav', 'opus']).describe('Audio format'),
  mimeType: z.string().describe('MIME type (e.g., audio/pcm, audio/mpeg)'),
  metadata: z.object({
    sampleRate: z.number().optional(),
    channels: z.number().optional(),
    bitDepth: z.number().optional(),
  }).catchall(z.any()).optional(),
});
export type LlmAudioContent = z.infer<typeof llmAudioContentSchema>;

/**
 * Multi-modal content block in LLM output
 */
export const llmContentSchema = z.discriminatedUnion('contentType', [
  llmTextContentSchema,
  llmImageContentSchema,
  llmAudioContentSchema,
]);
export type LlmContent = z.infer<typeof llmContentSchema>;

/**
 * Streaming chunk from LLM provider (text-only)
 */
export const llmChunkSchema = z.object({
  id: z.string(),
  content: z.string(),
  role: messageRoleSchema.optional(),
  finishReason: z.enum(['stop', 'length', 'tool_calls', 'content_filter']).nullable().optional(),
  usage: tokenUsageSchema.partial().optional(),
});
export type LlmChunk = z.infer<typeof llmChunkSchema>;

/**
 * Complete generation result with multi-modal support
 */
export const llmGenerationResultSchema = z.object({
  id: z.string(),
  content: z.array(llmContentSchema).describe('Array of content blocks supporting multiple modalities'),
  role: messageRoleSchema,
  finishReason: z.enum(['stop', 'length', 'tool_calls', 'content_filter']),
  usage: tokenUsageSchema.optional(),
  metadata: z.record(z.string(), z.any()).optional(),
});
export type LlmGenerationResult = z.infer<typeof llmGenerationResultSchema>;

/**
 * Generation options for LLM requests
 */
export const llmGenerationOptionsSchema = z.object({
  maxTokens: z.number().describe('Maximum number of tokens to generate').optional(),
  metadata: z.record(z.string(), z.any()).describe('Custom metadata to attach to the request').optional(),
  outputFormat: z.enum(['text', 'json', 'image', 'audio']).describe('Output format for the generation').optional(),
  schema: z.record(z.string(), z.any()).describe('JSON Schema the response must conform to. Providers reporting structuredOutput() === "tool" enforce it through the API; every other provider ignores it, exactly as they ignore outputFormat').optional(),
  schemaName: z.string().describe('Name for the schema, surfaced to the model as the tool name. Defaults to "structured_output"').optional(),
});
export type LlmGenerationOptions = z.infer<typeof llmGenerationOptionsSchema>;

/**
 * How strongly a provider can constrain the SHAPE of its own output.
 *
 * - `tool`  the API guarantees it: a forced tool call or a json_schema response format.
 *           Malformed output is not possible.
 * - `json`  the API guarantees valid JSON but not the requested shape.
 * - `none`  the model is asked in prose and may answer in prose. The default, so a
 *           provider that has not been taught this behaves exactly as it did before.
 */
export const structuredOutputSupportSchema = z.enum(['tool', 'json', 'none']);
export type StructuredOutputSupport = z.infer<typeof structuredOutputSupportSchema>;

/**
 * A validated structured generation, plus enough provenance to tell a clean first
 * attempt from a salvaged one.
 */
export interface StructuredGenerationResult<T> {
  /** The parsed, schema-validated value. */
  value: T;
  /** The underlying generation, kept so callers can still read usage and metadata. */
  raw: LlmGenerationResult;
  /** Which rung of the ladder actually produced this value. */
  mode: StructuredOutputSupport;
  /** 1 when the first attempt validated, 2 when the retry did. */
  attempts: number;
}

/**
 * Thrown when structured output could not be obtained at all.
 *
 * This exists so that "the model declined to act" and "we never found out what the
 * model said" stop being the same value. Callers must decide what an unanswered
 * classification means for them; they must not be able to mistake it for a decision.
 */
export class StructuredOutputError extends Error {
  constructor(
    message: string,
    /** The last raw text the model produced, for the log. */
    public readonly rawOutput?: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'StructuredOutputError';
  }
}

/**
 * Callback for streaming chunks
 */
export type LlmChunkCallback = (chunk: LlmChunk) => Promise<void> | Promise<void>;

/**
 * Callback for complete generation
 */
export type LlmCompleteCallback = (result: LlmGenerationResult) => void | Promise<void>;

/**
 * Base configuration for all LLM providers
 */
// export interface LlmProviderConfig {
//   apiKey: string;
//   baseUrl?: string;
//   model: string;
//   defaultMaxTokens?: number;
//   defaultTemperature?: number;
//   defaultTopP?: number;
//   timeout?: number;
//   [key: string]: any;
// }

/**
 * Interface for LLM provider implementations
 * Supports both streaming and non-streaming generation with multi-modal messages
 */
export interface ILlmProvider {
  /**
   * Initialize the provider with configuration
   * @param config Provider-specific configuration
   */
  init(): Promise<void>;

  /**
   * Generate a non-streaming response
   * @param messages Message history including multi-modal content
   * @param options Generation options
   * @returns Complete generation result
   */
  generate(messages: LlmMessage[], options?: LlmGenerationOptions): Promise<LlmGenerationResult>;

  /**
   * Report how strongly this provider can constrain the shape of its output.
   * Defaults to 'none' in LlmProviderBase, so no provider is forced to change.
   */
  structuredOutput(): StructuredOutputSupport;

  /**
   * Generate a response that is guaranteed to satisfy `validator`, or throw.
   *
   * Implemented once in LlmProviderBase over `generate`, so every call site gets the
   * same contract no matter which of the providers is configured: a validated object,
   * or a StructuredOutputError. Never a value that merely looks like an answer.
   *
   * @param messages Message history
   * @param validator Zod schema the parsed response must satisfy
   * @param options Generation options; pass `schema` to give tool-capable providers
   *                a compact JSON Schema instead of one derived from `validator`
   */
  generateStructured<T>(messages: LlmMessage[], validator: ZodType<T>, options?: LlmGenerationOptions): Promise<StructuredGenerationResult<T>>;

  /**
   * Generate a streaming response
   * @param messages Message history including multi-modal content
   * @param options Generation options
   * @returns Promise that resolves when streaming is complete
   */
  generateStream(messages: LlmMessage[], options?: LlmGenerationOptions): Promise<void>;

  /**
   * Set callback for streaming chunks
   * @param callback Function to call for each chunk
   */
  setOnChunk(callback: LlmChunkCallback): void;

  /**
   * Set callback for when provider is ready
   * @param callback Function to call when provider is initialized and ready
   */
  setOnGenerationStarted(callback: SimpleCallback): void;

  /**
   * Set callback for generation completion
   * @param callback Function to call when generation completes
   */
  setOnGenerationCompleted(callback: LlmCompleteCallback): void;

  /**
   * Set callback for fatal errors
   * @param callback Function to call on fatal error
   */
  setOnError(callback: ErrorCallback): void;

  /**
   * Check if provider is initialized
   */
  isInitialized(): boolean;

  /**
   * Releases all resources held by the provider.
   * Must be called when the provider is no longer needed (e.g. on client disconnect).
   */
  cleanup(): Promise<void>;

  /**
   * Enumerate available models from the provider, returning an array of model information.
   */
  enumerateModels(): Promise<LlmModelInfo[]>;

  /**
   * Moderate user input for content policy violations. Returns whether the input was flagged and any applicable categories.
   * @param input User input to moderate
   * @returns Object containing flagged status and categories of violation
   */
  moderateUserInput(input: string): Promise<{ flagged: boolean; categories: string[] }>;
}
