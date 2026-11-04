import type { EmailMessage, EmailSender } from "./sender.js";

/**
 * Correos transaccionales por Postmark (API HTTP, sin SDK). Un error de Postmark
 * se lanza: quien llama decide si avisar al usuario o solo registrarlo.
 */
export class PostmarkEmailSender implements EmailSender {
  constructor(
    private opts: {
      token: string;
      /** "HablaHora <no-reply@ejemplo.com>" (firma verificada en Postmark) */
      from: string;
      /** "outbound" = transaccional (por defecto en Postmark) */
      messageStream?: string;
      fetch?: typeof fetch;
    },
  ) {}

  async send(m: EmailMessage): Promise<void> {
    const res = await (this.opts.fetch ?? fetch)("https://api.postmarkapp.com/email", {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-postmark-server-token": this.opts.token,
      },
      body: JSON.stringify({
        From: this.opts.from,
        To: m.to,
        Subject: m.subject,
        TextBody: m.text,
        MessageStream: this.opts.messageStream ?? "outbound",
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { ErrorCode?: number; Message?: string };
      throw new Error(`Postmark rechazó el correo (${res.status}, código ${body.ErrorCode ?? "?"}): ${body.Message ?? res.statusText}`);
    }
  }
}
