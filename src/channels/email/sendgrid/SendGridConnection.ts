import type { Session, SessionManager } from '../../SessionManager';
import type { CALOutputMessage } from '../../messages';
import { MailService } from '@sendgrid/mail';
import { EmailConnectionBase, type EmailHeaders } from '../shared/EmailConnectionBase';
import { logger } from '../../../utils/logger';

export class SendGridConnection extends EmailConnectionBase {
  readonly connectionType = 'sendgrid' as const;

  constructor(
    private readonly toAddress: string,
    fromAddress: string,
    threadingStrategy: 'messageId' | 'senderSubject',
    sessionManager: SessionManager,
    /** SendGrid API key for authentication. */
    private readonly apiKey: string,
  ) {
    super(fromAddress, threadingStrategy, sessionManager, 'sendgrid');
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

    await this.sendEmail(
      this.toAddress,
      'Re: Conversation',
      body,
    );
  }

  protected async sendEmail(to: string, subject: string, body: string, headers?: EmailHeaders): Promise<void> {
    const sg = new MailService();
    sg.setApiKey(this.apiKey);

    const mail = {
      to: [{ email: to }],
      from: { email: headers?.from ?? this.fromAddress },
      subject: headers?.subject ?? subject,
      text: body,
      ...(headers?.messageId ? { customArgs: { 'X-Message-ID': headers.messageId } } : {}),
    };

    try {
      await sg.send(mail);
      logger.info({ to, sessionId: this.session?.id }, 'SendGrid email sent');
    } catch (error) {
      logger.error({ error, to, sessionId: this.session?.id }, 'Failed to send SendGrid email');
    }
  }
}
