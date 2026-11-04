import type { FastifyInstance } from "fastify";
import { ChatMessageBody, ChatSessionCreate, MAX_CHAT_MESSAGE_CHARS } from "@hablahora/contracts";
import { z } from "zod";
import type { AgentEvent, BackgroundTasks, WebChatProcessor } from "@hablahora/core";
import { FixedWindowLimiter } from "../rate-limit.js";

export interface WebChatRoutesOptions {
  chat: WebChatProcessor;
  background: BackgroundTasks;
  /** sesiones nuevas por hora por IP (por defecto 20) */
  sessionsPerIpPerHour?: number;
}

const slugParams = z.object({ slug: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/).max(100) });
const sessionParams = slugParams.extend({ sessionId: z.string().regex(/^[A-Za-z0-9_-]{22}$/) });

const NOT_FOUND = { error: "not_found", message: "El chat o la sesión no existe" };

const UNAVAILABLE = {
  error: "chat_unavailable",
  message: "Este chat todavía no está disponible",
};

const TOO_MANY_SESSIONS = { error: "rate_limited", message: "Demasiadas conversaciones nuevas. Intenta más tarde." };
const SESSION_FULL = {
  error: "session_limit",
  message: "Esta conversación llegó a su límite de mensajes. Abre una nueva para seguir.",
};

/**
 * Chat web público. Sin login: el negocio sale del slug y el cliente es una
 * sesión anónima. Límites: sesiones nuevas por IP y mensajes por sesión.
 */
export function webChatRoutes(app: FastifyInstance, opts: WebChatRoutesOptions): void {
  const sessionsByIp = new FixedWindowLimiter(opts.sessionsPerIpPerHour ?? 20, 3_600_000);

  /** Nombre, idioma y estilo del negocio: lo primero que pide la página del chat. */
  app.get("/api/chat/:slug", async (req, reply) => {
    const params = slugParams.safeParse(req.params);
    if (!params.success) return reply.code(404).send(NOT_FOUND);
    const info = await opts.chat.publicInfo(params.data.slug);
    // embed.js lo lee desde el sitio del negocio: datos públicos, sin cookies
    reply.header("access-control-allow-origin", "*");
    if (!info) return reply.code(404).send(NOT_FOUND);
    return info;
  });

  /** Aviso de privacidad del chat (texto de la plataforma). */
  app.get("/api/privacy", async (_req, reply) => {
    const p = await opts.chat.privacy();
    reply.header("cache-control", "public, max-age=300");
    return { es: p.es, en: p.en, updatedAt: p.updatedAt?.toISOString() ?? null };
  });

  /** Logo del negocio. La URL lleva la versión (?v=): se puede guardar en caché para siempre. */
  app.get("/api/chat/:slug/logo", async (req, reply) => {
    const params = slugParams.safeParse(req.params);
    if (!params.success) return reply.code(404).send(NOT_FOUND);
    const logo = await opts.chat.logo(params.data.slug);
    if (!logo) return reply.code(404).send(NOT_FOUND);
    return reply
      .header("content-type", logo.mime)
      .header("cache-control", "public, max-age=31536000, immutable")
      .header("access-control-allow-origin", "*")
      .send(logo.data);
  });

  app.post("/api/chat/:slug/sessions", async (req, reply) => {
    const params = slugParams.safeParse(req.params);
    if (!params.success) return reply.code(404).send(NOT_FOUND);
    // detrás de un proxy, req.ip necesita trustProxy (H7)
    const body = ChatSessionCreate.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "invalid_input", message: "Idioma inválido (es o en)" });
    if (!sessionsByIp.take(req.ip)) return reply.code(429).send(TOO_MANY_SESSIONS);
    const session = await opts.chat.createSession(params.data.slug, body.data.locale);
    if (!session) return reply.code(404).send(NOT_FOUND);
    if (session === "unavailable") return reply.code(409).send(UNAVAILABLE);
    return reply.code(201).send({ sessionId: session.sessionId, locale: session.locale });
  });

  /** La conversación visible, para retomarla al recargar la página. */
  app.get("/api/chat/:slug/sessions/:sessionId/messages", async (req, reply) => {
    const params = sessionParams.safeParse(req.params);
    if (!params.success) return reply.code(404).send(NOT_FOUND);
    const session = await opts.chat.findSession(params.data.slug, params.data.sessionId);
    if (!session) return reply.code(404).send(NOT_FOUND);
    return opts.chat.transcript(session);
  });

  /**
   * Responde por Server-Sent Events:
   *   text    { text }  fragmento de la respuesta, a medida que se genera
   *   tool    { name }  el agente está usando una herramienta
   *   handoff {}        la conversación pasó a una persona
   *   error   { message }
   *   done    {}        fin del turno
   */
  app.post("/api/chat/:slug/sessions/:sessionId/messages", async (req, reply) => {
    const params = sessionParams.safeParse(req.params);
    if (!params.success) return reply.code(404).send(NOT_FOUND);
    const body = ChatMessageBody.safeParse(req.body);
    if (!body.success) {
      return reply
        .code(400)
        .send({ error: "invalid_message", message: `Escribe un mensaje de hasta ${MAX_CHAT_MESSAGE_CHARS} caracteres` });
    }
    const session = await opts.chat.findSession(params.data.slug, params.data.sessionId);
    if (!session) return reply.code(404).send(NOT_FOUND);
    if (!(await opts.chat.isEnabled(session))) return reply.code(409).send(UNAVAILABLE);
    if (!(await opts.chat.canSend(session))) return reply.code(429).send(SESSION_FULL);

    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no", // que un proxy no acumule la respuesta
    });
    const send = (event: string, data: object) => {
      if (!res.writableEnded && !res.destroyed) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    // el turno sigue aunque el cliente se desconecte; al cerrar el servidor se espera a que termine
    const turn = opts.chat
      .sendMessage(session, body.data.text, ({ type, ...data }: AgentEvent) => send(type, data), body.data.locale)
      .then(() => send("done", {}))
      .catch((err) => {
        app.log.error({ err, conversation: session.conversationId }, "chat web falló");
        send("error", { message: "No pudimos procesar tu mensaje. Intenta de nuevo." });
      })
      .finally(() => res.end());
    opts.background.track(turn);
    await turn;
  });
}
