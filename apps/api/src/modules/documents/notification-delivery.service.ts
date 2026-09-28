import { Injectable, Logger } from '@nestjs/common';

type EscalationEmail = { to: string; title: string; message: string };

@Injectable()
export class NotificationDeliveryService {
  private readonly logger = new Logger(NotificationDeliveryService.name);

  async sendEscalationEmail(email: EscalationEmail): Promise<boolean> {
    const apiKey = process.env.RESEND_API_KEY?.trim();
    const from = process.env.NOTIFICATION_EMAIL_FROM?.trim();
    if (!apiKey || !from) return false;

    const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (character) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[character] ?? character);
    try {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(10_000),
        body: JSON.stringify({
          from,
          to: [email.to],
          subject: email.title,
          text: `${email.title}\n\n${email.message}`,
          html: `<h2>${escapeHtml(email.title)}</h2><p>${escapeHtml(email.message)}</p>`,
        }),
      });
      if (!response.ok) {
        this.logger.error(`Escalation email delivery failed with HTTP ${response.status}.`);
        return false;
      }
      return true;
    } catch (error) {
      this.logger.error('Escalation email delivery request failed.', error instanceof Error ? error.stack : String(error));
      return false;
    }
  }
}
