import Anthropic from "@anthropic-ai/sdk";
import pg from "pg";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AgentRunner,
  BookingService,
  EmailCodeService,
  GraphWhatsAppSender,
  InboundProcessor,
  LogEmailSender,
  organizationLocale,
  PostmarkEmailSender,
  WebChatProcessor,
  type EmailSender,
} from "@hablahora/core";
import { createAuth } from "./auth.js";
import { ConfigError, loadConfig, type Config } from "./config.js";
import { bookingNotifier } from "./booking-notify.js";
import { handoffNotifier } from "./handoff-notify.js";
import { initMonitoring } from "./monitoring.js";
import { usageNotifier } from "./usage-notify.js";
import { buildServer } from "./server.js";

let config: Config;
try {
  config = loadConfig();
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}

const monitoring = initMonitoring(config.sentry ? { ...config.sentry, release: process.env.RENDER_GIT_COMMIT } : null);
// para el núcleo (chat, agente): lo que se registra como error también se reporta
const log = {
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: (...args: unknown[]) => {
    console.error(...args);
    monitoring.report(args.find((a) => a instanceof Error) ?? new Error(args.map(String).join(" ")));
  },
};

const db = new pg.Pool({ connectionString: config.databaseUrl }); // rol app_user, sin BYPASSRLS
// si la base se reinicia, el pool avisa con un error en una conexión libre: sin este
// manejador Node cerraría la API entera; el pool vuelve a conectar solo
db.on("error", (err) => console.error("[db] conexión perdida:", err.message));
// en desarrollo los correos (códigos, invitaciones) van al log; en producción, Postmark
const email: EmailSender =
  config.email.provider === "postmark" ? new PostmarkEmailSender({ token: config.email.token, from: config.email.from }) : new LogEmailSender();
const { consoleURL, chatPublicURL } = config;

const { auth, pool: authDb } = createAuth({
  databaseUrl: config.authDatabaseUrl, // rol auth_user: solo el esquema auth
  baseURL: config.auth.baseURL,
  secret: config.auth.secret,
  trustedOrigins: config.auth.trustedOrigins,
  consoleURL,
  email,
  organizationLocale: (orgId) => organizationLocale(db, orgId),
});
const serverModel = config.anthropic.model;
const notifyHandoff = handoffNotifier({ db, authDb, email, consoleURL, log });
const bookings = new BookingService(db, undefined, bookingNotifier({ db, authDb, email, consoleURL, log }));
const anthropic = new Anthropic({ apiKey: config.anthropic.apiKey });

const runner = new AgentRunner({
  db,
  bookings,
  emailCodes: new EmailCodeService({ db, email }),
  // en streaming: el chat web muestra el texto a medida que llega
  llm: async (params, opts) => {
    const stream = anthropic.beta.messages.stream({
      ...(params as Anthropic.Beta.Messages.MessageCreateParamsNonStreaming),
      // Red de seguridad: si algo antes de un bloque de pensamiento cambió (la API lo liga a
      // todo lo anterior), la API lo descarta en lugar de rechazar la llamada con un 400.
      thinking: { type: "adaptive", block_binding: { prefix_mismatch_behavior: "drop_block" } },
      betas: ["thinking-binding-controls-2026-08-01"],
    });
    if (opts?.onText) stream.on("text", opts.onText);
    const message = await stream.finalMessage();
    // descartes por historial modificado (cambiar de modelo también descarta, y eso es normal)
    const dropped = (message.input_transformations ?? []).filter(
      (t) => t.type === "thinking_dropped" && (t as { reason?: string }).reason === "prefix_binding_mismatch",
    );
    if (dropped.length) {
      // no debería pasar (el historial solo crece): si pasa, es un error nuestro que conviene ver
      log.error(new Error(`La API descartó ${dropped.length} bloque(s) de pensamiento: ${JSON.stringify(dropped)}`));
    }
    return message as unknown as Anthropic.Message;
  },
  // el de la plataforma o el del negocio, si los fijaron desde la consola del owner, tienen prioridad
  model: serverModel,
  effort: config.anthropic.effort,
  log,
  // aviso por correo a los administradores del negocio (el staff ve el contador de la consola)
  onHandoff: (conv, reason) => {
    console.info(`[handoff] conversación ${conv.id} (${conv.channel}): ${reason}`);
    return notifyHandoff(conv, reason);
  },
});

// WhatsApp queda apagado en la v1: solo se activa si están sus tres variables.
function whatsapp() {
  const wa = config.whatsapp;
  if (!wa) return undefined;
  // MVP: un token para todos los números. Con Embedded Signup, buscar el token del negocio.
  const sender = new GraphWhatsAppSender({ graphVersion: wa.graphVersion, accessToken: async () => wa.accessToken });
  return { processor: new InboundProcessor({ db, runner, sender, log }), appSecret: wa.appSecret, verifyToken: wa.verifyToken };
}

// la consola y el chat compilados (npm run build), servidos por la API en su dominio
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const sites = config.serveStatic
  ? [
      { host: new URL(consoleURL).host, root: resolve(repo, "apps/console/dist"), frameable: false },
      { host: new URL(chatPublicURL).host, root: resolve(repo, "apps/chat/dist"), frameable: true },
    ]
  : [];
const browserSentry = config.sentry ? new URL(config.sentry.dsn) : null;

const wa = whatsapp();
const { app } = buildServer({
  whatsapp: wa,
  webChat: new WebChatProcessor({
    db,
    runner,
    log,
    maxMessagesPerSession: config.chat.maxMessagesPerSession,
    onUsageWarning: usageNotifier({ db, authDb, email, consoleURL, log }),
  }),
  chatSessionsPerIpPerHour: config.chat.sessionsPerIpPerHour,
  auth: {
    auth,
    authDb,
    db,
    trustedOrigins: config.auth.trustedOrigins,
    // base del chat público para enlaces y código para incrustar
    chatPublicURL,
    bookings,
    email,
    consoleURL,
    serverModel,
  },
  logger: { level: "info", hooks: monitoring.loggerHooks },
  trustProxy: config.trustProxy,
  web: {
    sites,
    hsts: config.production,
    // el navegador manda los errores de las apps a Sentry
    connectSrc: browserSentry ? [browserSentry.origin.replace(/^https:\/\/[^.]+\./, "https://*.")] : [],
  },
  publicConfig: { sentryDsn: config.sentry?.dsn ?? null, environment: config.sentry?.environment ?? config.env },
});

// Liberar holds vencidos cada minuto. Con una sola instancia alcanza; con varias, pasar a pg-boss.
const expiry = setInterval(() => {
  db.query("SELECT expire_stale_holds()").catch((err) => app.log.error({ err }, "expire_stale_holds falló"));
}, 60_000);

const shutdown = async () => {
  clearInterval(expiry);
  await app.close(); // espera a que terminen las conversaciones en curso
  await db.end();
  await authDb.end();
  await monitoring.flush();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

await app.listen({ port: config.port, host: "0.0.0.0" });
app.log.info(
  `Entorno ${config.env}; correo ${config.email.provider}; monitoreo ${monitoring.enabled ? "activo" : "apagado"}; ` +
    `apps ${sites.length ? sites.map((s) => s.host).join(" y ") : "servidas por Vite (desarrollo)"}; WhatsApp ${wa ? "activo" : "apagado"}`,
);
