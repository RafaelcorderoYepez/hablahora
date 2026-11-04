import { appendMessage, upsertConversation } from "../agent/conversations.js";
import { errorReplyText, type AgentRunner } from "../agent/runner.js";
import { withTenant, type Db } from "../db/tenant.js";
import { KeyedQueue } from "../util/keyed-queue.js";
import type { WhatsAppSender } from "./sender.js";
import { splitForWhatsApp, type InboundMessage } from "./webhook.js";

const UNSUPPORTED = {
  es: "Por ahora solo puedo leer mensajes de texto. ¿Me lo escribes, por favor?",
  en: "For now I can only read text messages. Could you type it for me, please?",
};

export interface InboundProcessorOptions {
  db: Db;
  runner: AgentRunner;
  sender: WhatsAppSender;
  clock?: () => Date;
  log?: Pick<Console, "info" | "warn" | "error">;
}

/**
 * Lleva un mensaje entrante de WhatsApp hasta la respuesta:
 * negocio → deduplicación → conversación → agente → envío.
 */
export class InboundProcessor {
  private queue = new KeyedQueue();
  private clock: () => Date;
  private log: Pick<Console, "info" | "warn" | "error">;

  constructor(private opts: InboundProcessorOptions) {
    this.clock = opts.clock ?? (() => new Date());
    this.log = opts.log ?? console;
  }

  async process(msg: InboundMessage): Promise<void> {
    const { db, runner, sender } = this.opts;

    // 1. ¿De qué negocio es este número? (función SECURITY DEFINER: aún no hay tenant)
    const { rows } = await db.query("SELECT * FROM resolve_wa_location($1)", [msg.phoneNumberId]);
    const loc = rows[0];
    if (!loc) {
      this.log.warn(`[wa] número sin negocio asociado: ${msg.phoneNumberId}`);
      return;
    }

    // 2. Deduplicar (Meta reintenta) y registrar la conversación, en una transacción
    const conv = await withTenant(db, loc.tenant_id, async (tx) => {
      const fresh = await tx.query(
        `INSERT INTO wa_inbound_events (wa_message_id, tenant_id) VALUES ($1, $2)
         ON CONFLICT DO NOTHING RETURNING wa_message_id`,
        [msg.waMessageId, loc.tenant_id],
      );
      if (fresh.rowCount === 0) return null;
      return upsertConversation(tx, {
        tenantId: loc.tenant_id,
        locationId: loc.location_id,
        channel: "whatsapp",
        externalId: msg.from,
        profileName: msg.profileName,
        now: this.clock(),
      });
    });
    if (!conv) return;

    sender.markRead(msg.phoneNumberId, msg.waMessageId).catch((e) => this.log.warn("[wa] markRead falló", e));

    // 3. Un mensaje a la vez por conversación
    await this.queue.run(conv.id, async () => {
      const locale = await this.locale(loc.tenant_id, loc.location_id);
      let replies: string[];

      if (msg.kind !== "text" || !msg.text) {
        const text = locale.startsWith("en") ? UNSUPPORTED.en : UNSUPPORTED.es;
        await withTenant(db, loc.tenant_id, async (tx) => {
          await appendMessage(tx, conv, { role: "user", content: `[${msg.originalType} no soportado]` }, "customer", msg.waMessageId);
          if (!conv.handoff) await appendMessage(tx, conv, { role: "assistant", content: text }, "agent");
        });
        replies = conv.handoff ? [] : [text];
      } else {
        try {
          replies = await runner.handleCustomerText({
            conversationId: conv.id,
            tenantId: loc.tenant_id,
            text: msg.text,
            waMessageId: msg.waMessageId,
          });
        } catch (err) {
          this.log.error("[agent] falló la conversación", conv.id, err);
          replies = [errorReplyText(locale)];
        }
      }

      for (const reply of replies) {
        for (const part of splitForWhatsApp(reply)) {
          await sender.sendText(msg.phoneNumberId, msg.from, part);
        }
      }
    });
  }

  private async locale(tenantId: string, locationId: string): Promise<string> {
    return withTenant(this.opts.db, tenantId, async (tx) => {
      const { rows } = await tx.query("SELECT default_locale FROM locations WHERE id = $1", [locationId]);
      return rows[0]?.default_locale ?? "es";
    });
  }
}
