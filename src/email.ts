import { randomUUID } from 'node:crypto';
import type { Database } from './db.js';
import type { AppConfig } from './config.js';
import { tokenDigest } from './security.js';

export interface EmailMessage {
  userId: string | null;
  to: string;
  template: 'verify_email' | 'password_reset' | 'master_invite' | 'flight_quote_customer' | 'flight_quote_master' | 'partner_invite'
    | 'partner_referral_confirmed' | 'partner_proposal_converted' | 'partner_commission_paid' | 'partner_weekly_summary';
  subject: string;
  html: string;
  text?: string;
  /**
   * Optional provider-level idempotency key. When present, it is passed through to the
   * Resend-backed sender as an `Idempotency-Key` header (per Resend's documented idempotency
   * support), so a genuine duplicate send attempt (e.g. an outbox row resent after a lost claim
   * lock, or a caller-level retry) is deduplicated by the provider itself rather than relying
   * solely on this app's own outbox claim/lease. Delivery is "at least once, deduplicated by the
   * provider" — never promised as "exactly once".
   */
  idempotencyKey?: string;
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
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.config.RESEND_API_KEY}`,
      'content-type': 'application/json',
    };
    // See EmailMessage.idempotencyKey: Resend documents `Idempotency-Key` as the supported header
    // for deduplicating a repeated send of the same logical message.
    if (message.idempotencyKey) headers['idempotency-key'] = message.idempotencyKey;
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers,
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
