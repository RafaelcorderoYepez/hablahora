import { PlatformSettings, PublicChatInfo, WebChatInfo } from "@hablahora/contracts";
import { AgentRunner, BookingService, MemoryEmailSender, WebChatProcessor } from "@hablahora/core";
import { AURORA, seedSalonAurora } from "@hablahora/db";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAuth } from "../../src/auth.js";
import { AURORA_USERS, DEV_PASSWORD, seedAuroraUsers } from "../../src/seed-users.js";
import { buildServer } from "../../src/server.js";
import { browser, ORIGIN } from "../../../../test/support/auth.js";
import { FAKE_MODEL, FakeLlm } from "../../../../test/support/fake-llm.js";
import { ADMIN_URL, APP_URL, AUTH_URL } from "../../../../test/support/global-setup.js";

/** Logo de cada negocio en su chat y aviso de privacidad de la plataforma (H7, parte 1). */

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP"), Buffer.alloc(32, 1)]);
const GIF = Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(32, 1)]);

let admin: pg.Pool;
let app: pg.Pool;
let authDb: pg.Pool;
let auth: ReturnType<typeof createAuth>["auth"];
let server: ReturnType<typeof buildServer>;
const llm = new FakeLlm();

beforeAll(async () => {
  admin = new pg.Pool({ connectionString: ADMIN_URL });
  app = new pg.Pool({ connectionString: APP_URL, max: 10 });
  const created = createAuth({
    databaseUrl: AUTH_URL,
    baseURL: ORIGIN,
    secret: "secreto-de-tests-0123456789-0123456789",
    trustedOrigins: [ORIGIN],
    consoleURL: ORIGIN,
    email: new MemoryEmailSender(),
  });
  auth = created.auth;
  authDb = created.pool;
  const runner = new AgentRunner({ db: app, bookings: new BookingService(app), model: FAKE_MODEL, llm: llm.client });
  server = buildServer({
    auth: { auth, authDb, db: app, trustedOrigins: [ORIGIN], chatPublicURL: "https://chat.hablahora.test" },
    webChat: new WebChatProcessor({ db: app, runner, log: { info() {}, warn() {}, error() {} } }),
  });
});

afterAll(async () => {
  await server.app.close();
  await authDb.end();
  await app.end();
  await admin.end();
});

beforeEach(async () => {
  await seedSalonAurora(admin);
  await seedAuroraUsers({ auth, authDb, adminDb: admin, tenantId: AURORA.tenant, slug: AURORA.slug });
});

afterEach(async () => {
  // el aviso es global: los demás archivos de tests lo comparten
  await admin.query("UPDATE platform_settings SET privacy_es = NULL, privacy_en = NULL, privacy_updated_at = NULL");
});

const as = async (who: keyof typeof AURORA_USERS) => {
  const b = browser(server.app);
  expect((await b.signIn(AURORA_USERS[who].email, DEV_PASSWORD)).statusCode).toBe(200);
  const upload = (body: Buffer | string, type: string, origin: string | null = ORIGIN) =>
    server.app.inject({
      method: "PUT",
      url: "/api/merchant/web-chat/logo",
      payload: body,
      headers: { cookie: b.cookie, "content-type": type, ...(origin ? { origin } : {}) },
    });
  const write = (method: "PUT" | "DELETE", url: string, payload?: unknown) =>
    server.app.inject({ method, url, ...(payload !== undefined ? { payload: payload as any } : {}), headers: { cookie: b.cookie, origin: ORIGIN } });
  return { ...b, upload, write };
};

const publicInfo = async () => PublicChatInfo.parse((await server.app.inject({ url: `/api/chat/${AURORA.slug}` })).json());

describe("logo del negocio", () => {
  it("la administradora lo sube; el chat lo muestra con una URL que se guarda en caché para siempre", async () => {
    expect((await publicInfo()).logoUrl).toBeNull();
    const v = await as("valeria");
    const res = await v.upload(PNG, "image/png");
    expect(res.statusCode).toBe(200);
    const { logoUrl } = res.json() as { logoUrl: string };
    expect(logoUrl).toMatch(new RegExp(`^/api/chat/${AURORA.slug}/logo\\?v=\\d+$`));

    expect(WebChatInfo.parse((await v.get("/api/merchant/web-chat")).json()).logoUrl).toBe(logoUrl);
    expect((await publicInfo()).logoUrl).toBe(logoUrl);

    const image = await server.app.inject({ url: logoUrl });
    expect(image.statusCode).toBe(200);
    expect(image.headers["content-type"]).toBe("image/png");
    expect(image.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(image.rawPayload.equals(PNG)).toBe(true);

    // reemplazarlo cambia la versión de la URL
    const replaced = (await v.upload(WEBP, "image/webp")).json() as { logoUrl: string };
    expect(replaced.logoUrl).not.toBe(logoUrl);
    expect((await server.app.inject({ url: replaced.logoUrl })).headers["content-type"]).toBe("image/webp");

    expect((await v.write("DELETE", "/api/merchant/web-chat/logo")).statusCode).toBe(204);
    expect((await publicInfo()).logoUrl).toBeNull();
    expect((await server.app.inject({ url: `/api/chat/${AURORA.slug}/logo` })).statusCode).toBe(404);
  });

  it("solo PNG, JPEG o WebP de verdad y hasta 256 KB", async () => {
    const v = await as("valeria");
    // un GIF que dice ser PNG: se mira el contenido, no lo que dice el navegador
    const fake = await v.upload(GIF, "image/png");
    expect(fake.statusCode).toBe(422);
    expect(fake.json()).toMatchObject({ reason: "logo_invalid" });
    const svg = await v.upload("<svg onload='alert(1)'/>", "image/svg+xml");
    expect(svg.statusCode).toBe(415);
    expect(svg.json()).toMatchObject({ reason: "logo_invalid" });
    const big = await v.upload(Buffer.concat([PNG, Buffer.alloc(256 * 1024)]), "image/png");
    expect(big.statusCode).toBe(413);
    expect(big.json()).toMatchObject({ reason: "logo_too_large" });
    expect((await publicInfo()).logoUrl).toBeNull();
  });

  it("el staff no lo cambia; sin origen de la consola, tampoco", async () => {
    const camila = await as("camila");
    expect((await camila.upload(PNG, "image/png")).statusCode).toBe(403);
    const v = await as("valeria");
    expect((await v.upload(PNG, "image/png", null)).statusCode).toBe(403);
  });
});

describe("aviso de privacidad", () => {
  it("sin texto no hay enlace; la plataforma lo escribe y el chat lo muestra", async () => {
    expect((await publicInfo()).privacy).toBe(false);
    expect((await server.app.inject({ url: "/api/privacy" })).json()).toEqual({ es: null, en: null, updatedAt: null });

    const p = await as("platformAdmin");
    const saved = PlatformSettings.parse(
      (await p.write("PUT", "/api/platform/settings", { defaultModel: null, privacyEs: "  Usamos tus datos solo para tu reserva.  ", privacyEn: "" })).json(),
    );
    expect(saved).toMatchObject({ privacyEs: "Usamos tus datos solo para tu reserva.", privacyEn: null });

    expect((await publicInfo()).privacy).toBe(true);
    const notice = (await server.app.inject({ url: "/api/privacy" })).json();
    expect(notice).toMatchObject({ es: "Usamos tus datos solo para tu reserva.", en: null });
    expect(notice.updatedAt).not.toBeNull();

    // cambiar solo el modelo no borra el aviso
    await p.write("PUT", "/api/platform/settings", { defaultModel: null });
    expect((await server.app.inject({ url: "/api/privacy" })).json()).toMatchObject({ es: "Usamos tus datos solo para tu reserva." });

    // un negocio no puede escribirlo
    const v = await as("valeria");
    expect((await v.write("PUT", "/api/platform/settings", { defaultModel: null, privacyEs: "otro" })).statusCode).toBe(403);
  });
});
