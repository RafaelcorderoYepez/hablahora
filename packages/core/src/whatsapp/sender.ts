export interface WhatsAppSender {
  sendText(phoneNumberId: string, to: string, body: string): Promise<void>;
  markRead(phoneNumberId: string, waMessageId: string): Promise<void>;
}

export interface GraphSenderOptions {
  /** versión de la Graph API, p. ej. "v23.0"; revisa la vigente en la documentación de Meta */
  graphVersion: string;
  /**
   * Token de acceso para el número del negocio. Con Embedded Signup cada
   * negocio tiene el suyo; guárdalo cifrado y resuélvelo aquí.
   */
  accessToken: (phoneNumberId: string) => Promise<string>;
  fetchImpl?: typeof fetch;
}

/** Envío por la WhatsApp Cloud API (graph.facebook.com). */
export class GraphWhatsAppSender implements WhatsAppSender {
  constructor(private opts: GraphSenderOptions) {}

  async sendText(phoneNumberId: string, to: string, body: string): Promise<void> {
    await this.post(phoneNumberId, {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: to.replace(/^\+/, ""),
      type: "text",
      text: { body, preview_url: false },
    });
  }

  async markRead(phoneNumberId: string, waMessageId: string): Promise<void> {
    await this.post(phoneNumberId, {
      messaging_product: "whatsapp",
      status: "read",
      message_id: waMessageId,
    });
  }

  private async post(phoneNumberId: string, payload: unknown): Promise<void> {
    const token = await this.opts.accessToken(phoneNumberId);
    const res = await (this.opts.fetchImpl ?? fetch)(
      `https://graph.facebook.com/${this.opts.graphVersion}/${phoneNumberId}/messages`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      },
    );
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`WhatsApp API ${res.status}: ${detail.slice(0, 500)}`);
    }
  }
}
