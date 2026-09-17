import { randomUUID } from 'node:crypto';
import type { Database } from './db.js';
import type { AppConfig } from './config.js';
import { tokenDigest } from './security.js';

export interface EmailMessage {
  userId: string | null;
  to: string;
  template: 'verify_email' | 'password_reset' | 'master_invite' | 'flight_quote_customer' | 'flight_quote_master';
  subject: string;
  html: string;
  text?: string;
}

export interface EmailSender {
  send(message: EmailMessage): Promise<void>;
}

export class TestEmailSender implements EmailSender {
  readonly messages: EmailMessage[] = [];
  async send(message: EmailMessage) {
    this.messages.push(message);
  }
}

export class RuntimeEmailSender implements EmailSender {
  constructor(private readonly db: Database, private readonly config: AppConfig) {}

  async send(message: EmailMessage) {
    const id = randomUUID();
    const recipientHash = tokenDigest(message.to, this.config.TOKEN_PEPPER);
    if (this.config.EMAIL_MODE === 'capture') {
      await this.db.query(
        `INSERT INTO email_events (id,user_id,template,recipient_hash,provider,status)
         VALUES ($1,$2,$3,$4,'local-capture','captured')`,
        [id, message.userId, message.template, recipientHash],
      );
      return;
    }
    if (!this.config.RESEND_API_KEY) throw new Error('RESEND_API_KEY is required');
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.config.RESEND_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ from: this.config.EMAIL_FROM, to: [message.to], subject: message.subject, html: message.html, text: message.text }),
    });
    const body = (await response.json().catch(() => ({}))) as { id?: string };
    await this.db.query(
      `INSERT INTO email_events (id,user_id,template,recipient_hash,provider,provider_reference,status,error_code)
       VALUES ($1,$2,$3,$4,'resend',$5,$6,$7)`,
      [id, message.userId, message.template, recipientHash, body.id ?? null, response.ok ? 'sent' : 'failed', response.ok ? null : `http_${response.status}`],
    );
    if (!response.ok) throw new Error('Transactional email provider rejected the message');
  }
}
