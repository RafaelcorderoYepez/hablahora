import { PostmarkEmailSender } from "@hablahora/core";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ConfigError, loadConfig } from "../src/config.js";
import { buildServer } from "../src/server.js";

/** Lo que el despliegue necesita: configuración validada, correo real, apps servidas y cabeceras. */

const BASE = {
  DATABASE_URL: "postgres://app@db/hablahora",
  AUTH_DATABASE_URL: "postgres://auth@db/hablahora",
  BETTER_AUTH_SECRET: "s".repeat(32),
  ANTHROPIC_API_KEY: "sk-ant-prueba",
};
const PROD = {
  ...BASE,
  NODE_ENV: "production",
  CONSOLE_URL: "https://app.hablahora.test",
  CHAT_PUBLIC_URL: "https://chat.hablahora.test",
  EMAIL_PROVIDER: "postmark",
  POSTMARK_SERVER_TOKEN: "pm-token",
  EMAIL_FROM: "HablaHora <no-reply@hablahora.test>",
};

const problems = (env: Record<string, string>) => {
  try {
    loadConfig(env);
  } catch (err) {
    if (err instanceof ConfigError) return err.problems;
    throw err;
  }
  return [];
};

describe("configuración", () => {
  it("desarrollo: valores por defecto, correo al log, sin apps servidas ni proxy", () => {
    const c = loadConfig({ ...BASE, CLAUDE_EFFORT: "" });
    expect(c).toMatchObject({
      env: "development",
      port: 3000,
      consoleURL: "http://localhost:5174",
      chatPublicURL: "http://localhost:5173",
      email: { provider: "log" },
      sentry: null,
      serveStatic: false,
      trustProxy: 0,
      whatsapp: null,
      anthropic: { model: "claude-sonnet-5-5", effort: undefined },
    });
    expect(c.auth.baseURL).toBe("http://localhost:3000");
    expect(c.auth.trustedOrigins).toEqual(["http://localhost:5174", "http://localhost:3000"]);
  });

  it("producción: la API vive en el dominio de la consola, sirve las apps y confía en un proxy", () => {
    const c = loadConfig({ ...PROD, SENTRY_DSN: "https://abc@o1.ingest.us.sentry.io/123" });
    expect(c).toMatchObject({
      production: true,
      serveStatic: true,
      trustProxy: 1,
      email: { provider: "postmark", token: "pm-token", from: "HablaHora <no-reply@hablahora.test>" },
      sentry: { dsn: "https://abc@o1.ingest.us.sentry.io/123", environment: "production" },
    });
    expect(c.auth.baseURL).toBe("https://app.hablahora.test");
    expect(c.auth.trustedOrigins).toEqual(["https://app.hablahora.test"]);
  });

  it("dice todo lo que falta o está mal, junto", () => {
    expect(problems({ BETTER_AUTH_SECRET: "corto" })).toEqual(
      expect.arrayContaining([
        "Falta DATABASE_URL (rol app_user)",
        "Falta AUTH_DATABASE_URL (rol auth_user)",
        "BETTER_AUTH_SECRET debe tener al menos 32 caracteres (openssl rand -base64 32)",
        "Falta ANTHROPIC_API_KEY",
      ]),
    );
    expect(problems({ ...BASE, CLAUDE_EFFORT: "turbo" })).toEqual(["CLAUDE_EFFORT debe ser low, medium, high, xhigh, max"]);
  });

  it("producción exige https, correo real y dominios distintos para la consola y el chat", () => {
    expect(problems({ ...PROD, CONSOLE_URL: "http://app.hablahora.test", EMAIL_PROVIDER: "log" })).toEqual([
      "BETTER_AUTH_URL debe usar https en producción",
      "CONSOLE_URL debe usar https en producción",
      "En producción EMAIL_PROVIDER debe ser postmark (los correos no pueden ir al log)",
    ]);
    expect(problems({ ...PROD, POSTMARK_SERVER_TOKEN: "", EMAIL_FROM: "" })).toEqual([
      "Falta POSTMARK_SERVER_TOKEN (Server API token de Postmark)",
      'Falta EMAIL_FROM (p. ej. "HablaHora <no-reply@ejemplo.com>")',
    ]);
    expect(problems({ ...PROD, BETTER_AUTH_SECRET: "cambia-esto-por-32-caracteres-al-azar" })).toEqual([
      "BETTER_AUTH_SECRET sigue siendo el de ejemplo: genera uno con openssl rand -base64 32",
    ]);
    expect(problems({ ...PROD, CHAT_PUBLIC_URL: "https://app.hablahora.test/chat" })).toEqual([
      "CONSOLE_URL y CHAT_PUBLIC_URL deben tener dominios distintos (la API sirve una app en cada uno)",
    ]);
  });
});

describe("correo por Postmark", () => {
  it("manda el correo con el token del servidor y avisa si Postmark lo rechaza", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ErrorCode: 0 }), { status: 200 }));
    const sender = new PostmarkEmailSender({ token: "pm-token", from: "HablaHora <no-reply@hablahora.test>", fetch: fetchMock as unknown as typeof fetch });
    await sender.send({ to: "rosa@example.com", subject: "Reserva confirmada", text: "Hola" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.postmarkapp.com/email");
    expect((init.headers as Record<string, string>)["x-postmark-server-token"]).toBe("pm-token");
    expect(JSON.parse(String(init.body))).toEqual({
      From: "HablaHora <no-reply@hablahora.test>",
      To: "rosa@example.com",
      Subject: "Reserva confirmada",
      TextBody: "Hola",
      MessageStream: "outbound",
    });

    const rejecting = new PostmarkEmailSender({
      token: "pm-token",
      from: "x",
      fetch: (async () => new Response(JSON.stringify({ ErrorCode: 300, Message: "Invalid email request" }), { status: 422 })) as unknown as typeof fetch,
    });
    await expect(rejecting.send({ to: "x", subject: "s", text: "t" })).rejects.toThrow("Postmark rechazó el correo (422, código 300): Invalid email request");
  });
});

describe("apps servidas por la API", () => {
  let dir: string;
  let server: ReturnType<typeof buildServer>;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "hablahora-static-"));
    for (const app of ["console", "chat"]) {
      mkdirSync(join(dir, app, "assets"), { recursive: true });
      writeFileSync(join(dir, app, "index.html"), `<!doctype html><title>${app}</title>`);
      writeFileSync(join(dir, app, "assets", "index-abc123.js"), `console.log("${app}")`);
    }
    writeFileSync(join(dir, "chat", "embed.js"), "/* embed */");
    server = buildServer({
      trustProxy: 1,
      web: {
        hsts: true,
        connectSrc: ["https://*.ingest.us.sentry.io"],
        sites: [
          { host: "app.hablahora.test", root: join(dir, "console"), frameable: false },
          { host: "chat.hablahora.test", root: join(dir, "chat"), frameable: true },
        ],
      },
      publicConfig: { sentryDsn: "https://abc@o1.ingest.us.sentry.io/123", environment: "production" },
    });
    server.app.get("/api/ip", async (req) => ({ ip: req.ip }));
  });

  afterAll(async () => {
    await server.app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const get = (host: string, url: string, headers: Record<string, string> = {}) => server.app.inject({ url, headers: { host, ...headers } });

  it("cada dominio su app; las rutas del cliente devuelven index.html sin caché", async () => {
    const consoleHome = await get("app.hablahora.test", "/");
    expect(consoleHome.body).toContain("<title>console</title>");
    const deep = await get("app.hablahora.test", "/agenda?date=2026-10-21");
    expect(deep.statusCode).toBe(200);
    expect(deep.body).toContain("<title>console</title>");
    expect(deep.headers["cache-control"]).toBe("no-cache");
    expect((await get("chat.hablahora.test", "/salon-aurora")).body).toContain("<title>chat</title>");
  });

  it("los archivos con hash se guardan un año; embed.js, unos minutos", async () => {
    const asset = await get("chat.hablahora.test", "/assets/index-abc123.js");
    expect(asset.body).toBe('console.log("chat")');
    expect(asset.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect((await get("chat.hablahora.test", "/embed.js")).headers["cache-control"]).toBe("public, max-age=300");
    // embed.js es del chat, no de la consola
    expect((await get("app.hablahora.test", "/embed.js")).statusCode).toBe(404);
    expect((await get("app.hablahora.test", "/assets/no-existe.js")).statusCode).toBe(404);
  });

  it("/api y /health siguen siendo de la API en los dos dominios", async () => {
    expect((await get("app.hablahora.test", "/health")).json()).toEqual({ ok: true });
    const missing = await get("chat.hablahora.test", "/api/no-existe");
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ error: "not_found" });
    const cfg = await get("chat.hablahora.test", "/api/public-config");
    expect(cfg.json()).toEqual({ sentryDsn: "https://abc@o1.ingest.us.sentry.io/123", environment: "production" });
  });

  it("cabeceras de seguridad: la consola no se puede incrustar; el chat sí (embed.js)", async () => {
    const consoleHome = await get("app.hablahora.test", "/");
    expect(consoleHome.headers).toMatchObject({
      "x-content-type-options": "nosniff",
      "referrer-policy": "strict-origin-when-cross-origin",
      "strict-transport-security": "max-age=31536000",
      "x-frame-options": "DENY",
    });
    const csp = String(consoleHome.headers["content-security-policy"]);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("connect-src 'self' https://*.ingest.us.sentry.io");

    const chat = await get("chat.hablahora.test", "/salon-aurora");
    expect(String(chat.headers["content-security-policy"])).toContain("frame-ancestors *");
    expect(chat.headers["x-frame-options"]).toBeUndefined();
    // la API (JSON) no lleva CSP de página, pero sí las cabeceras generales
    const api = await get("app.hablahora.test", "/health");
    expect(api.headers["content-security-policy"]).toBeUndefined();
    expect(api.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("detrás del balanceador, la IP del cliente es la que reenvía el proxy (un salto)", async () => {
    const res = await server.app.inject({ url: "/api/ip", headers: { host: "app.hablahora.test", "x-forwarded-for": "203.0.113.7" } });
    expect(res.json()).toEqual({ ip: "203.0.113.7" });
  });

  it("sin la app compilada, la API no arranca y dice qué falta", () => {
    expect(() =>
      buildServer({ web: { hsts: false, connectSrc: [], sites: [{ host: "app.hablahora.test", root: join(dir, "no-existe"), frameable: false }] } }),
    ).toThrow(/No está compilada la app de app\.hablahora\.test/);
  });
});
