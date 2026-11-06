import { resolveAccent, type ChatTranscript, type PublicChatInfo } from "@hablahora/contracts";
import {
  createWebConversation,
  findConversation,
  setConversationLocale,
  touchConversation,
  type Locale,
} from "../agent/conversations.js";
import { errorReplyText, type AgentEvent, type AgentRunner } from "../agent/runner.js";
import { withTenant, type Db } from "../db/tenant.js";
import { parseChatSettings } from "../merchant/config.js";
import { logoUrl, logoVersion } from "../merchant/logo.js";
import { getPrivacy, type PrivacyNotice } from "../platform/settings.js";
import { conversationsThisMonth, monthKey, tenantGate, USAGE_WARNING_RATIO } from "../platform/limits.js";
import { KeyedQueue } from "../util/keyed-queue.js";

export interface WebChatProcessorOptions {
  db: Db;
  runner: AgentRunner;
  clock?: () => Date;
  log?: Pick<Console, "info" | "warn" | "error">;
  /** mensajes del cliente por sesión (por defecto 60); después se rechazan */
  maxMessagesPerSession?: number;
  /** el negocio llegó al 80 % de las conversaciones de su plan (se llama una vez por mes) */
  onUsageWarning?: (u: { tenantId: string; used: number; limit: number }) => void | Promise<void>;
}

/** Una conversación del chat web, ya resuelta (negocio, sucursal y sesión). */
export interface WebChatSession {
  sessionId: string;
  tenantId: string;
  locationId: string;
  conversationId: string;
  /** idioma de la conversación (textos fijos e interfaz) */
  locale: Locale;
}

interface ResolvedLocation {
  tenantId: string;
  locationId: string;
  defaultLocale: Locale;
  timezone: string;
}

/**
 * Canal de chat web: el negocio sale del slug del enlace público y el cliente
 * es una sesión anónima. Usa el mismo AgentRunner que WhatsApp y entrega la
 * respuesta como eventos (para enviarlos por SSE a medida que llegan).
 */
export class WebChatProcessor {
  private queue = new KeyedQueue();
  private clock: () => Date;
  private log: Pick<Console, "info" | "warn" | "error">;

  constructor(private opts: WebChatProcessorOptions) {
    this.clock = opts.clock ?? (() => new Date());
    this.log = opts.log ?? console;
  }

  /** Lo que el chat necesita para pintarse (nombre, idioma, estilo); null si el slug no existe. */
  async publicInfo(slug: string): Promise<PublicChatInfo | null> {
    const loc = await this.resolve(slug);
    if (!loc) return null;
    return withTenant(this.opts.db, loc.tenantId, async (tx) => {
      const { rows } = await tx.query(
        `SELECT t.name, t.status, l.chat_settings, l.chat_enabled FROM locations l JOIN tenants t ON t.id = l.tenant_id WHERE l.id = $1`,
        [loc.locationId],
      );
      const settings = parseChatSettings(rows[0].chat_settings);
      const logo = await logoVersion(tx, loc.locationId);
      // el aviso de privacidad es de la plataforma (sin RLS)
      const privacy = await tx.query("SELECT (privacy_es IS NOT NULL OR privacy_en IS NOT NULL) AS has FROM platform_settings");
      return {
        name: rows[0].name,
        // un negocio suspendido o dado de baja no atiende
        available: rows[0].chat_enabled && rows[0].status === "active",
        locale: loc.defaultLocale,
        accent: resolveAccent(settings),
        appearance: settings.appearance,
        tint: settings.tint,
        texture: settings.texture,
        welcome: settings.welcome,
        logoUrl: logo ? logoUrl(slug, logo) : null,
        privacy: privacy.rows[0]?.has === true,
      };
    });
  }

  /** Aviso de privacidad del chat (lo escribe la plataforma; es el mismo para todos los negocios). */
  privacy(): Promise<PrivacyNotice> {
    return getPrivacy(this.opts.db);
  }

  /** El logo del negocio (imagen y tipo); null si el slug no existe o no tiene logo. */
  async logo(slug: string): Promise<{ mime: string; data: Buffer } | null> {
    const loc = await this.resolve(slug);
    if (!loc) return null;
    const { rows } = await withTenant(this.opts.db, loc.tenantId, (tx) =>
      tx.query("SELECT mime, data FROM location_logos WHERE location_id = $1", [loc.locationId]),
    );
    return rows[0] ? { mime: rows[0].mime, data: rows[0].data } : null;
  }

  /** Abre una sesión nueva; null si el slug no corresponde a ningún negocio. */
  async createSession(slug: string, locale?: Locale): Promise<WebChatSession | "unavailable" | null> {
    const loc = await this.resolve(slug);
    if (!loc) return null;
    if (!(await this.isEnabled(loc))) return "unavailable";
    const gate = await tenantGate(this.opts.db, loc.tenantId);
    const limit = gate?.maxConversationsPerMonth ?? null;
    const now = this.clock();
    const opened = await withTenant(this.opts.db, loc.tenantId, async (tx) => {
      // al llegar al límite del plan no se abren conversaciones nuevas; las abiertas siguen
      const used = limit != null ? await conversationsThisMonth(tx, loc.locationId, loc.timezone, now) : 0;
      if (limit != null && used >= limit) return null;
      const conv = await createWebConversation(tx, {
        tenantId: loc.tenantId,
        locationId: loc.locationId,
        locale: locale ?? loc.defaultLocale,
      });
      return { conv, used: used + 1 };
    });
    if (!opened) return "unavailable";
    if (limit != null && opened.used >= Math.ceil(limit * USAGE_WARNING_RATIO)) await this.warnUsage(loc, opened.used, limit, now);
    return session(opened.conv.externalId, opened.conv.id, loc, opened.conv.locale);
  }

  /** Aviso del 80 %: una vez por mes (tenants.usage_warned_month). */
  private async warnUsage(loc: ResolvedLocation, used: number, limit: number, now: Date): Promise<void> {
    if (!this.opts.onUsageWarning) return;
    const month = monthKey(now, loc.timezone);
    const { rowCount } = await this.opts.db.query(
      "UPDATE tenants SET usage_warned_month = $2 WHERE id = $1 AND usage_warned_month IS DISTINCT FROM $2",
      [loc.tenantId, month],
    );
    if (!rowCount) return;
    try {
      await this.opts.onUsageWarning({ tenantId: loc.tenantId, used, limit });
    } catch (err) {
      this.log.warn("[plan] no se pudo avisar del uso", loc.tenantId, err);
    }
  }

  /** La sesión existente, o null si el slug o la sesión no existen. */
  async findSession(slug: string, sessionId: string): Promise<WebChatSession | null> {
    const loc = await this.resolve(slug);
    if (!loc) return null;
    const conv = await withTenant(this.opts.db, loc.tenantId, (tx) =>
      findConversation(tx, { locationId: loc.locationId, channel: "web", externalId: sessionId }),
    );
    return conv ? session(sessionId, conv.id, loc, conv.locale) : null;
  }

  /** ¿El negocio tiene el chat activo? Apagado, no se abren sesiones ni se responden mensajes. */
  async isEnabled(session: Pick<WebChatSession, "tenantId" | "locationId">): Promise<boolean> {
    const { rows } = await withTenant(this.opts.db, session.tenantId, (tx) =>
      tx.query("SELECT l.chat_enabled, t.status FROM locations l JOIN tenants t ON t.id = l.tenant_id WHERE l.id = $1", [
        session.locationId,
      ]),
    );
    return rows[0]?.chat_enabled === true && rows[0]?.status === "active";
  }

  /** ¿Puede la sesión mandar otro mensaje? (límite de mensajes por sesión) */
  async canSend(session: WebChatSession): Promise<boolean> {
    const max = this.opts.maxMessagesPerSession ?? 60;
    const { rows } = await withTenant(this.opts.db, session.tenantId, (tx) =>
      tx.query(
        "SELECT count(*)::int AS n FROM conversation_messages WHERE conversation_id = $1 AND author = 'customer'",
        [session.conversationId],
      ),
    );
    return rows[0].n < max;
  }

  /**
   * Procesa un mensaje del cliente; los eventos llegan por `onEvent`.
   * Un mensaje a la vez por conversación: si llegan dos, el segundo espera.
   * Si el cliente se desconecta, el turno termina igual y queda guardado.
   * `locale`: si el cliente cambió el idioma de la página, queda guardado en la conversación.
   */
  async sendMessage(
    session: WebChatSession,
    text: string,
    onEvent: (event: AgentEvent) => void,
    locale?: Locale,
  ): Promise<void> {
    await this.queue.run(session.conversationId, async () => {
      await withTenant(this.opts.db, session.tenantId, async (tx) => {
        await touchConversation(tx, session.conversationId, this.clock());
        if (locale && locale !== session.locale) await setConversationLocale(tx, session.conversationId, locale);
      });
      const current = locale ?? session.locale;
      try {
        await this.opts.runner.handleCustomerText({
          conversationId: session.conversationId,
          tenantId: session.tenantId,
          text,
          onEvent,
        });
      } catch (err) {
        this.log.error("[agent] falló la conversación", session.conversationId, err);
        onEvent({ type: "text", text: errorReplyText(current) });
      }
    });
  }

  /** Lo que el cliente ve de la conversación: sus mensajes y las respuestas (sin herramientas). */
  async transcript(session: WebChatSession): Promise<ChatTranscript> {
    return withTenant(this.opts.db, session.tenantId, async (tx) => {
      const conv = await tx.query("SELECT handoff, locale FROM conversations WHERE id = $1", [session.conversationId]);
      const { rows } = await tx.query(
        `SELECT author, content, created_at FROM conversation_messages
          WHERE conversation_id = $1 AND author IN ('customer', 'agent', 'staff')
          ORDER BY id`,
        [session.conversationId],
      );
      const messages: ChatTranscript["messages"] = [];
      for (const r of rows) {
        const text = (Array.isArray(r.content) ? r.content : [])
          .filter((b: { type?: string }) => b.type === "text")
          .map((b: { text?: string }) => String(b.text ?? "").trim())
          .filter(Boolean)
          .join("\n\n");
        if (!text) continue; // vueltas del agente que solo pidieron herramientas
        messages.push({ role: r.author, text, at: r.created_at.toISOString() });
      }
      return { locale: conv.rows[0]?.locale ?? session.locale, handoff: conv.rows[0]?.handoff ?? false, messages };
    });
  }

  private async resolve(slug: string): Promise<ResolvedLocation | null> {
    // función SECURITY DEFINER: aún no hay tenant
    const { rows } = await this.opts.db.query("SELECT * FROM resolve_web_location($1)", [slug]);
    const loc = rows[0];
    if (!loc) return null;
    const extra = await withTenant(this.opts.db, loc.tenant_id, async (tx) => {
      const r = await tx.query("SELECT default_locale, timezone FROM locations WHERE id = $1", [loc.location_id]);
      return { defaultLocale: (r.rows[0]?.default_locale as Locale | undefined) ?? "es", timezone: r.rows[0]?.timezone as string };
    });
    return { tenantId: loc.tenant_id, locationId: loc.location_id, ...extra };
  }
}

function session(sessionId: string, conversationId: string, loc: ResolvedLocation, locale: Locale | null): WebChatSession {
  return {
    sessionId,
    conversationId,
    tenantId: loc.tenantId,
    locationId: loc.locationId,
    locale: locale ?? loc.defaultLocale,
  };
}
