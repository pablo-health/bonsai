import { IAudioConverter } from '../audio/IAudioConverter';
import { AudioConverterFactory } from '../audio/AudioConverterFactory';
import { isPcmFormat, pcmSampleRate, isG711Format } from '../audio/AudioFormatUtils';
import type { AudioFormat } from '../../types/audio';
import type { RecordingConfig } from '../../http/contracts/project';

type ProjectRecordingConfig = { enabled: boolean; recordInput?: boolean; recordOutput?: boolean; format?: string };
import type { ConversationStorageService } from '../ConversationStorageService';
import { logger } from '../../utils/logger';
import { getMimeTypeForRecordingFormat } from '../../utils/audioFormat';

export class ConversationRecorder {
  private inputConverter: IAudioConverter | null = null;
  private outputConverter: IAudioConverter | null = null;
  private inputChunks: Buffer[] = [];
  /** What the recogniser was fed, and the report that explains it. Set at flush time. */
  private asrFed: { audio: Buffer; report: Record<string, unknown> } | null = null;
  private outputChunks: Buffer[] = [];
  private recordingFormat: AudioFormat;
  private isFlushing = false;
  private recordInput: boolean;
  private recordOutput: boolean;

  constructor(
    private config: ProjectRecordingConfig,
    private inputSourceFormat: AudioFormat,
    private outputSourceFormat: AudioFormat,
    private storageService: ConversationStorageService,
    private storageConfig: { storageProviderId?: string; settings?: unknown } | null | undefined,
    private projectId: string,
    private conversationId: string,
  ) {
    this.recordingFormat = (config.format as AudioFormat) || 'pcm_16000';
    this.recordInput = config.recordInput !== false;
    this.recordOutput = config.recordOutput !== false;
  }

  async initialize(): Promise<void> {
    if (this.recordInput && this.inputSourceFormat !== this.recordingFormat) {
      this.inputConverter = await AudioConverterFactory.create(this.inputSourceFormat, this.recordingFormat);
      this.inputConverter.on('data', (chunk: Buffer) => this.inputChunks.push(chunk));
    }

    if (this.recordOutput && this.outputSourceFormat !== this.recordingFormat) {
      this.outputConverter = await AudioConverterFactory.create(this.outputSourceFormat, this.recordingFormat);
      this.outputConverter.on('data', (chunk: Buffer) => this.outputChunks.push(chunk));
    }
  }

  pushInput(chunk: Buffer): void {
    if (!this.recordInput) return;
    if (this.inputConverter) {
      this.inputConverter.push(chunk);
    } else {
      this.inputChunks.push(chunk);
    }
  }

  /**
   * Hands over the ASR feed capture. Called once, at teardown, with everything already
   * assembled - the tap itself does no work during the call beyond pushing buffers.
   */
  setAsrFeed(fed: { audio: Buffer; report: Record<string, unknown> }): void {
    this.asrFed = fed;
  }

  pushOutput(chunk: Buffer): void {
    if (!this.recordOutput) return;
    if (this.outputConverter) {
      this.outputConverter.push(chunk);
    } else {
      this.outputChunks.push(chunk);
    }
  }

  async flush(): Promise<void> {
    if (this.isFlushing) return;
    this.isFlushing = true;

    if (this.inputChunks.length === 0 && this.outputChunks.length === 0 && !this.asrFed) {
      return;
    }

    if (!this.storageConfig) {
      logger.warn({ conversationId: this.conversationId }, `Skipping recording flush for conversation ${this.conversationId}: no storage provider configured`);
      return;
    }

    const meta = this.buildRecordingMetadata();
    const contentType = getMimeTypeForRecordingFormat(this.recordingFormat);

    if (this.recordInput && this.inputChunks.length > 0) {
      const combined = Buffer.concat(this.inputChunks);
      try {
        await this.storageService.uploadArtifact(
          this.storageConfig,
          this.projectId,
          this.conversationId,
          'user_voice',
          combined,
          { contentType, customMetadata: meta },
        );
        logger.info({ conversationId: this.conversationId, size: combined.length }, `Flushed user voice recording for conversation ${this.conversationId}`);
      } catch (error) {
        logger.error({ conversationId: this.conversationId, error: error instanceof Error ? error.message : String(error) }, `Failed to flush user voice recording for conversation ${this.conversationId}`);
      }
    }

    if (this.recordOutput && this.outputChunks.length > 0) {
      const combined = Buffer.concat(this.outputChunks);
      try {
        await this.storageService.uploadArtifact(
          this.storageConfig,
          this.projectId,
          this.conversationId,
          'ai_voice',
          combined,
          { contentType, customMetadata: meta },
        );
        logger.info({ conversationId: this.conversationId, size: combined.length }, `Flushed AI voice recording for conversation ${this.conversationId}`);
      } catch (error) {
        logger.error({ conversationId: this.conversationId, error: error instanceof Error ? error.message : String(error) }, `Failed to flush AI voice recording for conversation ${this.conversationId}`);
      }
    }

    // The recogniser's own input, uploaded beside the caller's. The point of keeping both is
    // that they are NOT the same thing, and every hour spent assuming otherwise has been wasted.
    if (this.asrFed) {
      const { audio, report } = this.asrFed;
      try {
        if (audio.length > 0) {
          await this.storageService.uploadArtifact(
            this.storageConfig, this.projectId, this.conversationId, 'asr_fed', audio,
            { contentType, customMetadata: meta },
          );
        }
        await this.storageService.uploadArtifact(
          this.storageConfig, this.projectId, this.conversationId, 'asr_feed_report',
          Buffer.from(JSON.stringify(report, null, 1), 'utf-8'),
          { contentType: 'application/json' },
        );
        logger.info({
          conversationId: this.conversationId,
          fedBytes: report.fedBytes,
          framesAccepted: report.framesAccepted,
          framesDroppedNotRecognizing: report.framesDroppedNotRecognizing,
          framesDroppedAfterEnded: report.framesDroppedAfterEnded,
          sessions: report.sessions,
        }, `Flushed ASR feed capture for conversation ${this.conversationId}`);
      } catch (error) {
        logger.error({ conversationId: this.conversationId, error: error instanceof Error ? error.message : String(error) }, `Failed to flush ASR feed capture for conversation ${this.conversationId}`);
      }
      this.asrFed = null;
    }

    this.inputChunks = [];
    this.outputChunks = [];
  }

  destroy(): void {
    this.inputConverter?.destroy();
    this.inputConverter = null;
    this.outputConverter?.destroy();
    this.outputConverter = null;
  }

  private buildRecordingMetadata(): Record<string, string> {
    const meta: Record<string, string> = { format: this.recordingFormat };
    if (isPcmFormat(this.recordingFormat)) {
      meta.sampleRate = String(pcmSampleRate(this.recordingFormat));
    } else if (isG711Format(this.recordingFormat)) {
      meta.sampleRate = '8000';
    }
    return meta;
  }
}
