import { z } from "zod";

// Configuración de la API desde variables de entorno. Se valida todo al arrancar y,
// si algo falta o no sirve, la API no arranca y dice qué corregir (todo junto).

const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

const bool = z
  .enum(["true", "false", "1", "0"])
  .transform((v) => v === "true" || v === "1")
  .optional();

/** Obligatoria: el mismo mensaje si falta o si viene vacía. */
const required = (message: string) => z.string({ error: message }).min(1, message);

const url = (name: string) => z.string().url(`${name} debe ser una URL completa (p. ej. https://app.ejemplo.com)`);

const Env = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),

  DATABASE_URL: required("Falta DATABASE_URL (rol app_user)"),
  AUTH_DATABASE_URL: required("Falta AUTH_DATABASE_URL (rol auth_user)"),

  BETTER_AUTH_SECRET: z
    .string({ error: "Falta BETTER_AUTH_SECRET (openssl rand -base64 32)" })
    .min(32, "BETTER_AUTH_SECRET debe tener al menos 32 caracteres (openssl rand -base64 32)"),
  BETTER_AUTH_URL: url("BETTER_AUTH_URL").optional(),
  CONSOLE_URL: url("CONSOLE_URL").default("http://localhost:5174"),
  CHAT_PUBLIC_URL: url("CHAT_PUBLIC_URL").default("http://localhost:5173"),
  TRUSTED_ORIGINS: z.string().optional(),

  ANTHROPIC_API_KEY: required("Falta ANTHROPIC_API_KEY"),
  CLAUDE_MODEL: z.string().min(1).default("claude-sonnet-5-5"),
  CLAUDE_EFFORT: z
    .string()
    .optional()
    .transform((v) => v?.trim() || undefined)
    .pipe(z.enum(EFFORTS, { message: `CLAUDE_EFFORT debe ser ${EFFORTS.join(", ")}` }).optional()),

  CHAT_MAX_MESSAGES_PER_SESSION: z.coerce.number().int().min(1).default(60),
  CHAT_SESSIONS_PER_IP_PER_HOUR: z.coerce.number().int().min(1).default(20),

  // correo: "log" escribe los correos en el log (desarrollo); en producción, Postmark
  EMAIL_PROVIDER: z.enum(["log", "postmark"]).default("log"),
  POSTMARK_SERVER_TOKEN: z.string().optional(),
  EMAIL_FROM: z.string().optional(),

  // monitoreo de errores (Sentry); sin DSN, apagado
  SENTRY_DSN: z.string().url("SENTRY_DSN debe ser la URL que da Sentry").optional().or(z.literal("").transform(() => undefined)),
  SENTRY_ENVIRONMENT: z.string().optional(),

  // la API sirve también la consola y el chat (compilados), según el dominio de cada uno
  SERVE_STATIC: bool,
  // saltos de proxy delante de la API (el balanceador del hosting): para la IP real del cliente
  TRUST_PROXY: z.coerce.number().int().min(0).max(5).optional(),

  WA_APP_SECRET: z.string().optional(),
  WA_VERIFY_TOKEN: z.string().optional(),
  WA_ACCESS_TOKEN: z.string().optional(),
  WA_GRAPH_VERSION: z.string().default("v23.0"),
});

export interface Config {
  env: "development" | "production" | "test";
  production: boolean;
  port: number;
  databaseUrl: string;
  authDatabaseUrl: string;
  auth: { secret: string; baseURL: string; trustedOrigins: string[] };
  consoleURL: string;
  chatPublicURL: string;
  anthropic: { apiKey: string; model: string; effort?: (typeof EFFORTS)[number] };
  chat: { maxMessagesPerSession: number; sessionsPerIpPerHour: number };
  email: { provider: "log" } | { provider: "postmark"; token: string; from: string };
  sentry: { dsn: string; environment: string } | null;
  serveStatic: boolean;
  trustProxy: number;
  whatsapp: { appSecret: string; verifyToken: string; accessToken: string; graphVersion: string } | null;
}

export class ConfigError extends Error {
  constructor(public problems: string[]) {
    super(`Configuración inválida:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  }
}

const originOf = (u: string) => new URL(u).origin;
const hostOf = (u: string) => new URL(u).host;

/** Lee y valida la configuración; lanza ConfigError con todos los problemas juntos. */
export function loadConfig(source: Record<string, string | undefined> = process.env): Config {
  // las variables vacías cuentan como no definidas (así un .env con `CLAVE=` no rompe los valores por defecto)
  const cleaned = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== undefined && v !== ""));
  const parsed = Env.safeParse(cleaned);
  if (!parsed.success) throw new ConfigError(parsed.error.issues.map((i) => i.message));
  const e = parsed.data;
  const production = e.NODE_ENV === "production";
  const problems: string[] = [];

  const serveStatic = e.SERVE_STATIC ?? production;
  // en producción la API vive en el mismo dominio que la consola (cookies del mismo origen)
  const baseURL = e.BETTER_AUTH_URL ?? (production ? originOf(e.CONSOLE_URL) : `http://localhost:${e.PORT}`);

  if (production) {
    for (const [name, value] of [
      ["BETTER_AUTH_URL", baseURL],
      ["CONSOLE_URL", e.CONSOLE_URL],
      ["CHAT_PUBLIC_URL", e.CHAT_PUBLIC_URL],
    ] as const) {
      if (!value.startsWith("https://")) problems.push(`${name} debe usar https en producción`);
    }
    if (e.EMAIL_PROVIDER !== "postmark") problems.push("En producción EMAIL_PROVIDER debe ser postmark (los correos no pueden ir al log)");
    if (e.BETTER_AUTH_SECRET.startsWith("cambia-esto")) problems.push("BETTER_AUTH_SECRET sigue siendo el de ejemplo: genera uno con openssl rand -base64 32");
  }
  if (e.EMAIL_PROVIDER === "postmark") {
    if (!e.POSTMARK_SERVER_TOKEN) problems.push("Falta POSTMARK_SERVER_TOKEN (Server API token de Postmark)");
    if (!e.EMAIL_FROM) problems.push('Falta EMAIL_FROM (p. ej. "HablaHora <no-reply@ejemplo.com>")');
  }
  if (serveStatic && hostOf(e.CONSOLE_URL) === hostOf(e.CHAT_PUBLIC_URL)) {
    problems.push("CONSOLE_URL y CHAT_PUBLIC_URL deben tener dominios distintos (la API sirve una app en cada uno)");
  }
  if (problems.length) throw new ConfigError(problems);

  const trustedOrigins = [
    ...new Set([
      ...(e.TRUSTED_ORIGINS ?? "")
        .split(",")
        .map((o) => o.trim())
        .filter(Boolean),
      originOf(e.CONSOLE_URL),
      ...(production ? [] : [`http://localhost:${e.PORT}`]),
    ]),
  ];

  return {
    env: e.NODE_ENV,
    production,
    port: e.PORT,
    databaseUrl: e.DATABASE_URL,
    authDatabaseUrl: e.AUTH_DATABASE_URL,
    auth: { secret: e.BETTER_AUTH_SECRET, baseURL, trustedOrigins },
    consoleURL: e.CONSOLE_URL.replace(/\/+$/, ""),
    chatPublicURL: e.CHAT_PUBLIC_URL.replace(/\/+$/, ""),
    anthropic: { apiKey: e.ANTHROPIC_API_KEY, model: e.CLAUDE_MODEL, effort: e.CLAUDE_EFFORT },
    chat: { maxMessagesPerSession: e.CHAT_MAX_MESSAGES_PER_SESSION, sessionsPerIpPerHour: e.CHAT_SESSIONS_PER_IP_PER_HOUR },
    email:
      e.EMAIL_PROVIDER === "postmark" ? { provider: "postmark", token: e.POSTMARK_SERVER_TOKEN!, from: e.EMAIL_FROM! } : { provider: "log" },
    sentry: e.SENTRY_DSN ? { dsn: e.SENTRY_DSN, environment: e.SENTRY_ENVIRONMENT ?? e.NODE_ENV } : null,
    serveStatic,
    // en producción hay un balanceador delante (un salto); en desarrollo, ninguno
    trustProxy: e.TRUST_PROXY ?? (production ? 1 : 0),
    whatsapp:
      e.WA_APP_SECRET && e.WA_VERIFY_TOKEN && e.WA_ACCESS_TOKEN
        ? { appSecret: e.WA_APP_SECRET, verifyToken: e.WA_VERIFY_TOKEN, accessToken: e.WA_ACCESS_TOKEN, graphVersion: e.WA_GRAPH_VERSION }
        : null,
  };
}
