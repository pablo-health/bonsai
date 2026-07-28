import { injectable } from 'tsyringe';
import { and, eq, lt, ne } from 'drizzle-orm';
import { db } from '../db/index';
import { deferredProcessing } from '../db/schema';
import type { CALInputMessage } from '../channels/messages';

/** Entry passed to the queue method */
export interface DeferredProcessingEntry {
  sessionId: string;
  providerId: string;
  projectId: string;
  conversationId: string | null;
  channelType: string;
  processAt: Date;
  message: CALInputMessage;
}

/**
 * Service for queuing and managing deferred processing entries.
 * Injected by channel hosts to queue incoming messages for delayed processing.
 */
@injectable()
export class DeferredProcessingService {
  /**
   * Queue a message for deferred processing.
   * The message will be processed by ProcessingDeferralService when `processAt` elapses.
   */
  public async queue(entry: DeferredProcessingEntry): Promise<void> {
    await db.insert(deferredProcessing).values({
      id: `deferred_${crypto.randomUUID()}`,
      sessionId: entry.sessionId,
      providerId: entry.providerId,
      projectId: entry.projectId,
      conversationId: entry.conversationId,
      channelType: entry.channelType,
      processAt: entry.processAt,
      message: entry.message as Record<string, unknown>,
    });
  }

  /**
   * Cancel all pending messages for a given session.
   * Called when a session times out or is terminated.
   */
  public async cancelBySessionId(sessionId: string): Promise<void> {
    await db.update(deferredProcessing)
      .set({ status: 'cancelled', updatedAt: new Date() })
      .where(and(
        eq(deferredProcessing.sessionId, sessionId),
        eq(deferredProcessing.status, 'pending'),
      ));
  }

  /**
   * Cancel all pending messages for a given conversation.
   * Called when a conversation is ended.
   */
  public async cancelByConversationId(conversationId: string): Promise<void> {
    await db.update(deferredProcessing)
      .set({ status: 'cancelled', updatedAt: new Date() })
      .where(and(
        eq(deferredProcessing.conversationId, conversationId),
        eq(deferredProcessing.status, 'pending'),
      ));
  }

  /**
   * Clean up old processed/failed/cancelled records older than 7 days.
   * Called by ProcessingDeferralService during each poll cycle.
   */
  public async cleanupOldRecords(): Promise<void> {
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const result = await db.delete(deferredProcessing)
      .where(
        and(
          ne(deferredProcessing.status, 'pending'),
          lt(deferredProcessing.updatedAt, cutoff),
        ),
      )
      .returning({ id: deferredProcessing.id });

    if (result.length > 0) {
      const { logger } = await import('../utils/logger');
      logger.debug({ count: result.length }, 'Cleaned up old deferred processing records');
    }
  }
}
