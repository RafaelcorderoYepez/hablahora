export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

/**
 * Envío de correos (códigos del chat, invitaciones, recuperar contraseña).
 * El proveedor real se elige en H7; mientras tanto, LogEmailSender.
 */
export interface EmailSender {
  send(message: EmailMessage): Promise<void>;
}

/** Desarrollo: el correo se escribe en el log, para leer el código o el enlace ahí. */
export class LogEmailSender implements EmailSender {
  constructor(private log: Pick<Console, "info"> = console) {}

  async send(m: EmailMessage): Promise<void> {
    this.log.info(`[email] para ${m.to} — ${m.subject}\n${m.text}`);
  }
}

/** Tests: guarda los correos en memoria. */
export class MemoryEmailSender implements EmailSender {
  sent: EmailMessage[] = [];

  async send(m: EmailMessage): Promise<void> {
    this.sent.push(m);
  }

  /** Último correo enviado a esa dirección. */
  lastTo(to: string): EmailMessage | undefined {
    return [...this.sent].reverse().find((m) => m.to === to);
  }
}
