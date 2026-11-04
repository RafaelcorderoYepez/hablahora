import Fastify, { type FastifyInstance, type FastifyLoggerOptions } from "fastify";
import {
  BackgroundTasks,
  type BookingService,
  type EmailSender,
  type InboundProcessor,
  type WebChatProcessor,
} from "@hablahora/core";
import type pg from "pg";
import type { Auth } from "./auth.js";
import { authRoutes } from "./routes/auth.js";
import { merchantRoutes } from "./routes/merchant.js";
import { platformRoutes } from "./routes/platform.js";
import { webChatRoutes } from "./routes/web-chat.js";
import { whatsappRoutes } from "./routes/whatsapp.js";
import { securityHeaders, staticSites, type SecurityOptions, type StaticSite } from "./static.js";

export interface ServerOptions {
  /** Canal de WhatsApp: si no se indica, las rutas /webhook no existen. */
  whatsapp?: {
    processor: InboundProcessor;
    appSecret: string; // App Secret de la app de Meta (firma de webhooks)
    verifyToken: string; // el que configuras en el panel de Meta al suscribir el webhook
  };
  webChat?: WebChatProcessor;
  /** sesiones nuevas del chat por hora por IP */
  chatSessionsPerIpPerHour?: number;
  /** usuarios de las consolas (Better Auth) y endpoints del merchant */
  auth?: {
    auth: Auth;
    authDb: pg.Pool;
    db: pg.Pool;
    /** orígenes de las consolas (las escrituras del merchant solo se aceptan desde ellos) */
    trustedOrigins: string[];
    chatPublicURL?: string;
    clock?: () => Date;
    /** reservas desde la consola (si no se indica, se crea con db y clock) */
    bookings?: BookingService;
    /** avisos por email al cliente cuando el negocio cambia su reserva */
    email?: EmailSender;
    /** consola: enlaces de los correos de alta */
    consoleURL?: string;
    /** modelo de CLAUDE_MODEL (lo que usa el agente si la plataforma no fija otro) */
    serverModel?: string;
  };
  /** opciones de pino; `hooks.logMethod` permite reportar los errores (monitoring.ts) */
  logger?: boolean | (FastifyLoggerOptions & { level?: string; hooks?: { logMethod?: (this: unknown, args: unknown[], method: (...a: unknown[]) => void, level: number) => void } });
  /** saltos de proxy delante de la API (para la IP real del cliente); 0 = ninguno */
  trustProxy?: number;
  /** cabeceras de seguridad; con `sites`, la API sirve además esas apps compiladas */
  web?: SecurityOptions & { sites: StaticSite[] };
  /** lo que las apps necesitan en el navegador (GET /api/public-config): datos públicos */
  publicConfig?: { sentryDsn: string | null; environment: string };
}

export function buildServer(opts: ServerOptions): { app: FastifyInstance; background: BackgroundTasks } {
  // trustProxy: con N saltos, req.ip es la IP real del cliente detrás del balanceador del hosting
  const hops = opts.trustProxy ?? 0;
  const app = Fastify({ logger: opts.logger ?? false, trustProxy: hops > 0 ? (_addr: string, hop: number) => hop < hops : false });
  const background = new BackgroundTasks();

  app.get("/health", async () => ({ ok: true }));
  if (opts.web) {
    securityHeaders(app, opts.web.sites, opts.web);
    if (opts.web.sites.length) staticSites(app, opts.web.sites);
  }
  const publicConfig = opts.publicConfig ?? { sentryDsn: null, environment: "development" };
  app.get("/api/public-config", async (_req, reply) => {
    // la consola y el chat lo piden al cargar: datos públicos, sin cookies
    reply.header("cache-control", "public, max-age=300");
    return publicConfig;
  });

  // cada canal en su propio contexto: el parser de cuerpo crudo de WhatsApp no afecta al resto
  if (opts.whatsapp) {
    const wa = opts.whatsapp;
    app.register(async (scope) => whatsappRoutes(scope, { ...wa, background }));
  }
  if (opts.webChat) {
    const chat = opts.webChat;
    const sessionsPerIpPerHour = opts.chatSessionsPerIpPerHour;
    app.register(async (scope) => webChatRoutes(scope, { chat, background, sessionsPerIpPerHour }));
  }
  if (opts.auth) {
    const auth = opts.auth;
    app.register(async (scope) => authRoutes(scope, auth));
    app.register(async (scope) => merchantRoutes(scope, auth));
    app.register(async (scope) => platformRoutes(scope, auth));
  }

  app.addHook("onClose", async () => {
    await background.idle();
  });

  return { app, background };
}
