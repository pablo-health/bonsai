import type { Session, SessionManager } from '../../SessionManager';
import type { CALOutputMessage } from '../../messages';
import { MailService } from '@sendgrid/mail';
import { EmailConnectionBase, type EmailHeaders } from '../shared/EmailConnectionBase';
import { generateEmailMessageId } from '../shared/MessageIdUtils';
import { logger } from '../../../utils/logger';

export class SendGridConnection extends EmailConnectionBase {
  readonly connectionType = 'sendgrid' as const;

  private conversationId: string | undefined;

  constructor(
    private readonly toAddress: string,
    fromAddress: string,
    threadingStrategy: 'messageId' | 'senderSubject',
    sessionManager: SessionManager,
    private readonly subject: string,
    private readonly apiKey: string,
  ) {
    super(fromAddress, threadingStrategy, sessionManager, 'sendgrid');
  }

  setConversationId(id: string): void {
    this.conversationId = id;
  }

  attachSession(session: Session): void {
    this.session = session;
  }

  protected getRecipientAddress(): string {
    return this.toAddress;
  }

  protected getChannelLabel(): string {
    return 'SendGrid';
  }

  async sendMessage(msg: CALOutputMessage): Promise<void> {
    if (msg.type !== 'end_ai_generation_output') return;

    const body = msg.fullText?.trim();
    if (!body) return;

    const headers: EmailHeaders = {};
    if (this.conversationId) {
      headers.messageId = generateEmailMessageId(this.conversationId);
    }

    await this.sendEmail(this.toAddress, this.subject, body, headers);
  }

  protected async sendEmail(to: string, subject: string, body: string, headers?: EmailHeaders): Promise<void> {
    const sg = new MailService();
    sg.setApiKey(this.apiKey);

    const messageId = headers?.messageId ?? this.generateMessageId();

    const customArgs: Record<string, string> = { 'X-Message-ID': messageId };
    if (headers?.inReplyTo) customArgs['X-In-Reply-To'] = headers.inReplyTo;
    if (headers?.references) customArgs['X-References'] = headers.references;

    await sg.send({
      to: [{ email: to }],
      from: { email: headers?.from ?? this.fromAddress },
      subject: headers?.subject ?? subject,
      text: body,
      customArgs,
    });
    logger.info({ to, sessionId: this.session?.id }, 'SendGrid email sent');
  }
}
