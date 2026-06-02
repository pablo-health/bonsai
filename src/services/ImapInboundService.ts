import { inject, singleton, container } from 'tsyringe';
import ImapConnection from 'imap';
import { simpleParser } from 'mailparser';
import { eq, and } from 'drizzle-orm';
import { db } from '../db';
import { providers, apiKeys } from '../db/schema';
import { SmtpImapChannelHost } from '../channels/email/smtp-imap/SmtpImapChannelHost';
import { smtpImapChannelProviderConfigSchema } from './providers/channel/SmtpImapChannelProvider';
import { SecretRefUtils } from './secrets/SecretRefUtils';
import { logger } from '../utils/logger';

// Extend imap types to include IDLE methods not declared in @types/imap
interface ImapWithIdle extends ImapConnection {
  idle(): void;
  cancelIdle(): void;
}

type MailboxState = 'disconnected' | 'connecting' | 'idle' | 'polling' | 'searching';

class ImapMailboxSession {
  public state: MailboxState = 'disconnected';
  public imap: ImapWithIdle | null = null;
  public maxProcessedUid = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private consecutiveErrors = 0;
  public shouldStop = false;

  constructor(
    public readonly providerId: string,
    public readonly projectId: string,
    public readonly imapHost: string,
    public readonly imapPort: number,
    public readonly imapSecure: boolean,
    public readonly imapUser: string,
    public readonly imapPass: string,
    public readonly pollingIntervalMs: number,
    public readonly fromAddress: string,
    public readonly threadingStrategy: 'messageId' | 'senderSubject',
    public readonly smtpHost: string,
    public readonly smtpPort: number,
    public readonly smtpSecure: boolean,
    public readonly smtpAuthUser: string,
    public readonly smtpAuthPass: string,
    public readonly keySettings: Record<string, unknown> | null,
  ) {}

  public async connect(): Promise<void> {
    if (this.state !== 'disconnected') return;
    this.state = 'connecting';

    try {
      const imap = new ImapConnection({
        user: this.imapUser,
        password: this.imapPass,
        host: this.imapHost,
        port: this.imapPort,
        tls: this.imapSecure,
      }) as ImapWithIdle;

      await new Promise<void>((resolve, reject) => {
        imap.once('ready', () => resolve());
        imap.once('error', reject);
        imap.connect();
      });

      this.imap = imap;
      this.consecutiveErrors = 0;
      logger.info({ providerId: this.providerId, host: this.imapHost }, 'IMAP connected');

      await this.openInbox();
    } catch (error) {
      this.state = 'disconnected';
      this.imap = null;
      logger.error({ error, providerId: this.providerId, host: this.imapHost }, 'IMAP connection failed');
      this.scheduleReconnect();
    }
  }

  private async openInbox(): Promise<void> {
    if (!this.imap || this.shouldStop) return;

    return new Promise<void>((resolve, reject) => {
      this.imap!.openBox('INBOX', true, (err) => {
        if (err) {
          logger.error({ error: err, providerId: this.providerId }, 'Failed to open INBOX');
          reject(err);
          return;
        }
        logger.info({ providerId: this.providerId }, 'INBOX opened');
        resolve();
      });
    });
  }

  public startWatching(channelHost: SmtpImapChannelHost): void {
    if (!this.imap || this.shouldStop) return;
    this.state = 'idle';

    this.imap.on('error', (error) => {
      logger.error({ error, providerId: this.providerId }, 'IMAP connection error');
      this.state = 'disconnected';
      this.imap = null;
      this.scheduleReconnect();
    });

    this.imap.on('idle', () => {
      logger.debug({ providerId: this.providerId }, 'IMAP IDLE started');
      this.state = 'idle';
      this.clearPollTimer();
    });

    this.imap.on('mail', () => {
      logger.debug({ providerId: this.providerId }, 'New mail notification via IDLE');
      this.processNewMessages(channelHost);
    });

    this.imap.on('expunge', () => {
      logger.debug({ providerId: this.providerId }, 'IMAP expunge notification');
    });

    this.startIdle();
  }

  private startIdle(): void {
    if (!this.imap || this.shouldStop || this.state !== 'idle') return;

    try {
      this.imap.idle();
    } catch (error) {
      logger.warn({ error, providerId: this.providerId }, 'IDLE not supported or failed, falling back to polling');
      this.startPolling();
    }
  }

  private startPolling(): void {
    if (this.shouldStop) return;
    this.state = 'polling';
    this.clearPollTimer();

    this.pollTimer = setTimeout(async () => {
      if (this.shouldStop) return;
      try {
        await this.processNewMessagesDirect();
      } catch (error) {
        logger.error({ error, providerId: this.providerId }, 'Error during IMAP polling');
      }
      this.startIdle();
    }, this.pollingIntervalMs);

    if (this.pollTimer) {
      this.pollTimer.unref?.();
    }
  }

  private async processNewMessages(channelHost: SmtpImapChannelHost): Promise<void> {
    if (!this.imap || this.shouldStop) return;

    try {
      this.imap.cancelIdle();
      await this.processNewMessagesDirect();
      this.startIdle();
    } catch (error) {
      logger.error({ error, providerId: this.providerId }, 'Error processing new messages');
      this.state = 'disconnected';
      this.imap = null;
      this.scheduleReconnect();
    }
  }

  private async processNewMessagesDirect(): Promise<void> {
    if (!this.imap || this.shouldStop) return;
    this.state = 'searching';

    try {
      const results = await new Promise<any[]>((resolve, reject) => {
        this.imap!.search([
          ['UNSEEN'],
          ['UID', '>1'],
        ], (err, results) => {
          if (err) reject(err);
          else resolve(results);
        });
      });

      if (results.length === 0) return;

      for (const msg of results) {
        if (this.shouldStop) break;
        if (msg.attr <= this.maxProcessedUid) continue;

        await this.fetchAndProcessMessage(msg.attr);
      }
    } catch (error) {
      logger.error({ error, providerId: this.providerId }, 'Failed to search for new messages');
    } finally {
      if (!this.shouldStop) {
        this.state = 'idle';
      }
    }
  }

  private async fetchAndProcessMessage(uid: number): Promise<void> {
    if (!this.imap || this.shouldStop) return;

    try {
      const fetch = this.imap.fetch([uid], {});

      const source = await new Promise<string>((resolve, reject) => {
        let source = '';
        fetch.on('message', (msg) => {
          msg.on('body', (stream) => {
            stream.on('data', (chunk) => {
              source += chunk.toString('utf8');
            });
            stream.on('end', () => {
              resolve(source);
            });
          });
          msg.on('end', () => {
            if (!source) {
              resolve('');
            }
          });
        });
        fetch.on('error', reject);
      });

      if (!source) return;

      const parsed = await simpleParser(source);
      const senderEmail = parsed.from?.value?.[0]?.address ?? parsed.from?.text ?? 'unknown';
      const emailBody = parsed.text?.trim() ?? parsed.textAsHtml?.trim() ?? parsed.html?.trim() ?? '';
      const subject = parsed.subject ?? '';
      const messageId = parsed.headers.get('message-id')?.[0] as string | undefined;
      const inReplyTo = parsed.headers.get('in-reply-to')?.[0] as string | undefined;
      const references = parsed.headers.get('references')?.[0] as string | undefined;

      if (!emailBody) {
        logger.debug({ uid, providerId: this.providerId }, 'Empty email body, skipping');
        return;
      }

      logger.info({
        uid,
        from: senderEmail,
        subject,
        providerId: this.providerId,
        projectId: this.projectId,
      }, 'Processing inbound email');

      const channelHost = container.resolve(SmtpImapChannelHost);
      await channelHost.handleInboundEmail(
        this.projectId,
        this.keySettings,
        this.fromAddress,
        this.threadingStrategy,
        this.smtpHost,
        this.smtpPort,
        this.smtpSecure,
        this.smtpAuthUser,
        this.smtpAuthPass,
        senderEmail,
        emailBody,
        subject,
        messageId,
        inReplyTo,
        references,
        undefined,
        undefined,
      );

      this.maxProcessedUid = Math.max(this.maxProcessedUid, uid);
      await markSeen(this.imap, uid).catch((error) => {
        logger.warn({ error, uid, providerId: this.providerId }, 'Failed to mark message as seen');
      });

    } catch (error) {
      logger.error({ error, uid, providerId: this.providerId }, 'Failed to process email');
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.shouldStop) return;
    const delay = Math.min(1000 * Math.pow(2, this.consecutiveErrors), 300000);
    this.consecutiveErrors++;
    logger.info({ providerId: this.providerId, delay }, 'Scheduling IMAP reconnect');

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (!this.shouldStop) {
        await this.connect();
        if (this.imap) {
          const channelHost = container.resolve(SmtpImapChannelHost);
          this.startWatching(channelHost);
        }
      }
    }, delay);

    if (this.reconnectTimer) {
      this.reconnectTimer.unref?.();
    }
  }

  private clearPollTimer(): void {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  public async stop(): Promise<void> {
    this.shouldStop = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.clearPollTimer();

    if (this.imap) {
      try {
        this.imap.cancelIdle();
      } catch { /* ignore */ }
      this.imap.end();
      this.imap = null;
    }
    this.state = 'disconnected';
    logger.info({ providerId: this.providerId }, 'IMAP session stopped');
  }
}

async function markSeen(imap: ImapConnection, uid: number): Promise<void> {
  return new Promise((resolve, reject) => {
    imap.setFlags('\\Seen', [uid], (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

@singleton()
export class ImapInboundService {
  private sessions: Map<string, ImapMailboxSession> = new Map();
  private isStarted = false;

  constructor(
    @inject(SecretRefUtils) private readonly secretRefUtils: SecretRefUtils,
  ) {}

  start(): void {
    if (this.isStarted) {
      logger.warn('ImapInboundService already started');
      return;
    }
    this.isStarted = true;
    logger.info('Starting ImapInboundService');
    this.discoverAndConnect().catch((error) => {
      logger.error({ error }, 'Failed to discover IMAP providers');
    });
  }

  stop(): void {
    this.isStarted = false;
    const promises: Promise<void>[] = [];
    for (const session of this.sessions.values()) {
      promises.push(session.stop());
    }
    Promise.allSettled(promises).then(() => {
      this.sessions.clear();
      logger.info('ImapInboundService stopped');
    });
  }

  private async discoverAndConnect(): Promise<void> {
    try {
      const providerRecords = await db.query.providers.findMany({
        where: and(
          eq(providers.providerType, 'channel'),
        ),
      });

      const smtpImapProviders = providerRecords.filter((p) => p.apiType === 'smtp_imap');

      for (const provider of smtpImapProviders) {
        const rawConfig = await this.secretRefUtils.resolveObject(provider.config as Record<string, unknown>);
        const configResult = smtpImapChannelProviderConfigSchema.safeParse(rawConfig);

        if (!configResult.success) {
          logger.warn({ providerId: provider.id, issues: configResult.error.issues }, 'SMTP/IMAP provider config invalid, skipping');
          continue;
        }

        const config = configResult.data;

        if (!config.imap) {
          logger.debug({ providerId: provider.id }, 'SMTP/IMAP provider has no IMAP config, skipping inbound');
          continue;
        }

        const apiKeyRecord = await this.findProjectApiKey(config.projectId);
        if (!apiKeyRecord) {
          logger.warn({ providerId: provider.id, projectId: config.projectId }, 'No API key found for project, skipping IMAP inbound');
          continue;
        }

        const session = new ImapMailboxSession(
          provider.id,
          config.projectId,
          config.imap.host,
          config.imap.port,
          config.imap.secure,
          config.imap.auth.user,
          config.imap.auth.pass,
          config.imap.pollingIntervalMs,
          config.fromAddress,
          config.threadingStrategy,
          config.smtp.host,
          config.smtp.port,
          config.smtp.secure,
          config.smtp.auth.user,
          config.smtp.auth.pass,
          apiKeyRecord.keySettings ?? null,
        );

        this.sessions.set(provider.id, session);
        await session.connect();

        if (session.imap) {
          const channelHost = container.resolve(SmtpImapChannelHost);
          session.startWatching(channelHost);
        }
      }
    } catch (error) {
      logger.error({ error }, 'Error during IMAP provider discovery');
    }
  }

  private async findProjectApiKey(projectId: string): Promise<{ key: string; keySettings: Record<string, unknown> | null } | null> {
    const keys = await db.select().from(apiKeys).where(eq(apiKeys.projectId, projectId));

    const activeKey = keys.find((k) => k.isActive);
    if (activeKey) {
      return {
        key: activeKey.key,
        keySettings: activeKey.keySettings ?? null,
      };
    }
    return null;
  }
}
