import type { Session, SessionManager } from '../../SessionManager';
import type { CALOutputMessage } from '../../messages';
import * as nodemailer from 'nodemailer';
import { EmailConnectionBase, type EmailHeaders } from '../shared/EmailConnectionBase';
import { logger } from '../../../utils/logger';

export class SmtpImapConnection extends EmailConnectionBase {
  readonly connectionType = 'smtp_imap' as const;

  private transporter: nodemailer.Transporter;
  private readonly smtpAuthUser: string;
  private conversationId: string | undefined;

  constructor(
    private readonly toAddress: string,
    fromAddress: string,
    threadingStrategy: 'messageId' | 'senderSubject',
    sessionManager: SessionManager,
    private readonly subject: string,
    smtpHost: string,
    smtpPort: number,
    smtpSecure: boolean,
    smtpAuthUser: string,
    smtpAuthPass: string,
  ) {
    super(fromAddress, threadingStrategy, sessionManager, 'smtp_imap');
    this.smtpAuthUser = smtpAuthUser;
    this.transporter = nodemailer.createTransport({
      host: smtpHost,
      port: smtpPort,
      secure: smtpSecure,
      auth: {
        user: smtpAuthUser,
        pass: smtpAuthPass,
      },
    });
  }

  async verifyConnection(): Promise<void> {
    try {
      await this.transporter.verify();
      logger.info({ to: this.toAddress }, 'SMTP/IMAP: transporter verified successfully');
    } catch (error) {
      logger.error({ error, to: this.toAddress }, 'SMTP/IMAP: transporter verification failed');
      throw error;
    }
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
    return 'SMTP/IMAP';
  }

  async sendMessage(msg: CALOutputMessage): Promise<void> {
    if (msg.type !== 'end_ai_generation_output') return;

    const body = msg.fullText?.trim();
    if (!body) return;

    const headers: EmailHeaders = {};
    if (this.conversationId) {
      headers.messageId = `<${this.conversationId}@bonsai.ai>`;
    }

    await this.sendEmail(this.toAddress, this.subject, body, headers);
  }

 protected async sendEmail(to: string, subject: string, body: string, headers?: EmailHeaders): Promise<void> {
    const messageId = headers?.messageId ?? this.generateMessageId();

    const mailOptions: nodemailer.SendMailOptions = {
      from: headers?.from ?? this.fromAddress ?? this.smtpAuthUser,
      to,
      subject: headers?.subject ?? subject,
      text: body,
      headers: {},
    };

    (mailOptions.headers as Record<string, string>)['Message-ID'] = messageId;
    if (headers?.inReplyTo) {
      (mailOptions.headers as Record<string, string>)['In-Reply-To'] = headers.inReplyTo;
    }
    if (headers?.references) {
      (mailOptions.headers as Record<string, string>)['References'] = headers.references;
    }

    try {
      const info = await this.transporter.sendMail(mailOptions);
      logger.info({ to, messageId, sessionId: this.session?.id, messageIdRemote: info.messageId }, 'SMTP/IMAP email sent');
    } catch (error) {
      logger.error({ error, to, messageId, sessionId: this.session?.id }, 'Failed to send SMTP/IMAP email');
    }
  }
}
