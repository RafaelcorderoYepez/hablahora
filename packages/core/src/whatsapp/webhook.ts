import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verifica X-Hub-Signature-256: HMAC-SHA256 del cuerpo crudo con el App Secret.
 * Debe calcularse sobre los bytes exactos recibidos, no sobre el JSON re-serializado.
 */
export function verifySignature(rawBody: Buffer, header: string | undefined, appSecret: string): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const received = Buffer.from(header.slice("sha256=".length), "hex");
  const expected = createHmac("sha256", appSecret).update(rawBody).digest();
  return received.length === expected.length && timingSafeEqual(received, expected);
}

export type InboundKind = "text" | "unsupported";

export interface InboundMessage {
  phoneNumberId: string; // número del negocio que recibió el mensaje
  from: string; // cliente, E.164 con "+"
  waMessageId: string;
  timestamp: Date;
  kind: InboundKind;
  text?: string;
  originalType: string;
  profileName?: string;
}

/**
 * Extrae los mensajes de un webhook de la Cloud API. Ignora estados
 * (sent/delivered/read) y otros campos. Los botones y listas interactivas
 * se tratan como texto con el título elegido.
 */
export function parseWebhook(body: any): InboundMessage[] {
  if (body?.object !== "whatsapp_business_account") return [];
  const out: InboundMessage[] = [];
  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field !== "messages") continue;
      const value = change.value ?? {};
      const phoneNumberId: string | undefined = value.metadata?.phone_number_id;
      if (!phoneNumberId) continue;
      const names = new Map<string, string>(
        (value.contacts ?? []).map((c: any) => [c.wa_id, c.profile?.name]),
      );
      for (const m of value.messages ?? []) {
        const text = extractText(m);
        out.push({
          phoneNumberId,
          from: m.from?.startsWith("+") ? m.from : `+${m.from}`,
          waMessageId: m.id,
          timestamp: new Date(Number(m.timestamp) * 1000),
          kind: text ? "text" : "unsupported",
          text: text ?? undefined,
          originalType: m.type,
          profileName: names.get(m.from) ?? undefined,
        });
      }
    }
  }
  return out;
}

function extractText(m: any): string | null {
  switch (m.type) {
    case "text":
      return m.text?.body?.trim() || null;
    case "interactive":
      return m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? null;
    case "button":
      return m.button?.text ?? null;
    default:
      return null; // audio, imagen, ubicación, sticker...
  }
}

/** WhatsApp limita los textos a 4096 caracteres; corta por párrafos cuando puede. */
export function splitForWhatsApp(text: string, max = 4096): string[] {
  if (text.length <= max) return [text];
  const parts: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n\n", max);
    if (cut < max / 2) cut = rest.lastIndexOf("\n", max);
    if (cut < max / 2) cut = rest.lastIndexOf(" ", max);
    if (cut <= 0) cut = max;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}
