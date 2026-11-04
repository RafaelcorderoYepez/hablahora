import { Readiness } from "@hablahora/contracts";
import {
  AgentRunner,
  BookingService,
  MemoryEmailSender,
  organizationLocale,
  WebChatProcessor,
} from "@hablahora/core";
import { AURORA, seedSalonAurora } from "@hablahora/db";
import { DateTime } from "luxon";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAuth } from "../../src/auth.js";
import { createBusiness } from "../../src/business-create.js";
import { AURORA_USERS, DEV_PASSWORD, seedAuroraUsers } from "../../src/seed-users.js";
import { buildServer } from "../../src/server.js";
import { browser, ORIGIN } from "../../../../test/support/auth.js";
import { call, FAKE_MODEL, FakeLlm, findInHistory, say } from "../../../../test/support/fake-llm.js";
import { ADMIN_URL, APP_URL, AUTH_URL } from "../../../../test/support/global-setup.js";
import { chatClient } from "../../../../test/support/web-chat.js";

/** Alta de negocios, checklist, idioma de los usuarios y administradores del negocio. */

const CONSOLE = "http://consola.test";
const NEW_EMAILS = ["marta@norte.test", "owner@sunset.test", "ana@norte.test"];

let admin: pg.Pool;
let app: pg.Pool;
let authDb: pg.Pool;
let auth: ReturnType<typeof createAuth>["auth"];
let server: ReturnType<typeof buildServer>;
let now: Date;
const emails = new MemoryEmailSender();
const llm = new FakeLlm();

beforeAll(async () => {
  admin = new pg.Pool({ connectionString: ADMIN_URL });
  app = new pg.Pool({ connectionString: APP_URL, max: 10 });
  const created = createAuth({
    databaseUrl: AUTH_URL,
    baseURL: ORIGIN,
    secret: "secreto-de-tests-0123456789-0123456789",
    trustedOrigins: [ORIGIN],
    consoleURL: CONSOLE,
    email: emails,
    organizationLocale: (orgId) => organizationLocale(app, orgId),
  });
  auth = created.auth;
  authDb = created.pool;
  const clock = () => now;
  const runner = new AgentRunner({ db: app, bookings: new BookingService(app, clock), clock, model: FAKE_MODEL, llm: llm.client });
  server = buildServer({
    auth: { auth, authDb, db: app, trustedOrigins: [ORIGIN], clock },
    webChat: new WebChatProcessor({ db: app, runner, clock, log: { info() {}, warn() {}, error() {} } }),
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
  await removeNewBusinesses();
  now = DateTime.fromISO("2026-10-12T12:00", { zone: "America/New_York" }).toJSDate();
  emails.sent = [];
  llm.reset();
});

afterEach(() => expect(llm.stepErrors).toEqual([]));

async function removeNewBusinesses() {
  const { rows } = await admin.query("SELECT id FROM tenants WHERE id <> $1 AND auth_organization_id IS NOT NULL", [AURORA.tenant]);
  for (const { id } of rows) {
    for (const t of [
      "tool_calls", "llm_usage", "conversation_messages", "email_verifications", "booking_events", "booking_resources",
      "bookings", "conversations", "customers", "booking_policies", "availability_exceptions", "availability_rules",
      "service_resources", "services", "resources", "locations",
    ]) {
      await admin.query(`DELETE FROM ${t} WHERE tenant_id = $1`, [id]);
    }
    await admin.query("DELETE FROM tenants WHERE id = $1", [id]);
  }
  await authDb.query(`DELETE FROM organization WHERE slug <> $1`, [AURORA.slug]);
  await authDb.query(`DELETE FROM "user" WHERE email = ANY($1)`, [NEW_EMAILS]);
}

const deps = () => ({ auth, authDb, db: app, consoleURL: CONSOLE });
const post = (b: ReturnType<typeof browser>, url: string, payload: unknown) => b.post(url, payload);

/** Del correo de bienvenida o de recuperar contraseña, el token del enlace. */
const tokenFrom = (text: string) => /reset-password\/([^?\s]+)/.exec(text)![1];

describe("alta de un negocio nuevo", () => {
  it("crea dueño sin contraseña, organización, negocio y sucursal; el dueño crea su contraseña y entra", async () => {
    const created = await createBusiness(deps(), {
      name: "Barbería Norte",
      owner: { email: "Marta@Norte.test", name: "Marta" },
      timezone: "America/Chicago",
    });
    expect(created).toMatchObject({ slug: "barberia-norte", existingOwner: false });

    const loc = await admin.query("SELECT name, timezone, default_locale, web_chat_slug FROM locations WHERE tenant_id = $1", [created.tenantId]);
    expect(loc.rows).toEqual([{ name: "Barbería Norte", timezone: "America/Chicago", default_locale: "es", web_chat_slug: "barberia-norte" }]);

    const mail = emails.lastTo("marta@norte.test")!;
    expect(mail.subject).toBe("Bienvenido a HablaHora: crea tu contraseña");
    expect(mail.text).toContain(encodeURIComponent(`${CONSOLE}/restablecer`));

    const reset = await post(browser(server.app), "/api/auth/reset-password", { token: tokenFrom(mail.text), newPassword: "clave-de-marta-123" });
    expect(reset.statusCode).toBe(200);
    const marta = browser(server.app);
    expect((await marta.signIn("marta@norte.test", "clave-de-marta-123")).statusCode).toBe(200);
    expect((await marta.get("/api/me")).json()).toMatchObject({
      business: { tenantId: created.tenantId, name: "Barbería Norte", role: "merchant_admin" },
    });
  });

  it("un negocio en inglés manda la bienvenida y sus invitaciones en inglés; un slug ocupado lleva número", async () => {
    await createBusiness(deps(), { name: "Salón Aurora", owner: { email: "owner@sunset.test", name: "Sam" }, locale: "en" });
    const welcome = emails.lastTo("owner@sunset.test")!;
    expect(welcome.subject).toBe("Welcome to HablaHora: create your password");
    const slug = await admin.query("SELECT web_chat_slug FROM locations l JOIN tenants t ON t.id = l.tenant_id WHERE t.name = 'Salón Aurora' AND t.id <> $1", [AURORA.tenant]);
    expect(slug.rows[0].web_chat_slug).toBe("salon-aurora-2");

    await post(browser(server.app), "/api/auth/reset-password", { token: tokenFrom(welcome.text), newPassword: "clave-de-sam-1234" });
    const sam = browser(server.app);
    await sam.signIn("owner@sunset.test", "clave-de-sam-1234");
    const me = (await sam.get("/api/me")).json();
    const invite = await post(sam, "/api/auth/organization/invite-member", {
      email: "ana@norte.test",
      role: "member",
      organizationId: me.business.organizationId,
    });
    expect(invite.statusCode).toBe(200);
    expect(emails.lastTo("ana@norte.test")!.subject).toBe("You're invited to Salón Aurora on HablaHora");
  });

  it("si el dueño ya tiene cuenta, se le suma el negocio sin correo de bienvenida", async () => {
    const created = await createBusiness(deps(), { name: "Aurora Kids", owner: { email: AURORA_USERS.valeria.email, name: "Valeria" } });
    expect(created.existingOwner).toBe(true);
    expect(emails.sent).toEqual([]);
    const members = await authDb.query(`SELECT role FROM member WHERE "organizationId" = $1`, [created.organizationId]);
    expect(members.rows).toEqual([{ role: "owner" }]);
  });
});

describe("qué falta para atender", () => {
  it("el Salón Aurora está listo; un negocio recién creado no", async () => {
    const valeria = browser(server.app);
    await valeria.signIn(AURORA_USERS.valeria.email, DEV_PASSWORD);
    expect(Readiness.parse((await valeria.get("/api/merchant/readiness")).json())).toEqual({
      ready: true,
      checks: [
        { key: "services", ok: true, required: true },
        { key: "hours", ok: true, required: true },
        { key: "web_chat_slug", ok: true, required: true },
        { key: "agent_knowledge", ok: true, required: false },
      ],
    });

    const created = await createBusiness(deps(), { name: "Barbería Norte", owner: { email: "marta@norte.test", name: "Marta" } });
    await post(browser(server.app), "/api/auth/reset-password", { token: tokenFrom(emails.lastTo("marta@norte.test")!.text), newPassword: "clave-de-marta-123" });
    const marta = browser(server.app);
    await marta.signIn("marta@norte.test", "clave-de-marta-123");
    const readiness = Readiness.parse((await marta.get("/api/merchant/readiness")).json());
    expect(readiness.ready).toBe(false);
    expect(Object.fromEntries(readiness.checks.map((c) => [c.key, c.ok]))).toEqual({
      services: false,
      hours: false,
      web_chat_slug: true,
      agent_knowledge: false,
    });
    expect(created.slug).toBe("barberia-norte");
  });

  it("recorrido completo: negocio nuevo, configuración por la API y su chat reserva", async () => {
    await createBusiness(deps(), { name: "Barbería Norte", owner: { email: "marta@norte.test", name: "Marta" } });
    await post(browser(server.app), "/api/auth/reset-password", { token: tokenFrom(emails.lastTo("marta@norte.test")!.text), newPassword: "clave-de-marta-123" });
    const marta = browser(server.app);
    await marta.signIn("marta@norte.test", "clave-de-marta-123");
    const write = (method: "POST" | "PUT" | "PATCH", url: string, payload: unknown) =>
      server.app.inject({ method, url, payload: payload as any, headers: { cookie: marta.cookie, origin: ORIGIN } });

    // recién creado, el chat está apagado y no se puede activar sin lo mínimo
    expect((await server.app.inject({ method: "POST", url: "/api/chat/barberia-norte/sessions" })).statusCode).toBe(409);
    const early = await write("PATCH", "/api/merchant/business", { chatEnabled: true });
    expect(early.statusCode).toBe(422);
    expect(early.json()).toMatchObject({ reason: "chat_not_ready", details: { missing: ["services", "hours"] } });

    const tomas = (await write("POST", "/api/merchant/staff", { name: "Tomás" })).json();
    const barba = (await write("POST", "/api/merchant/services", { name: "Barba", durationMin: 30, price: 2000, staffIds: [tomas.id] })).json();
    expect(barba.id).toBeDefined();
    await write("PUT", "/api/merchant/hours", { schedule: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start: "10:00", end: "18:00" })) });
    await write("PATCH", "/api/merchant/business", { agentInstructions: "Estacionamiento en la esquina." });
    expect((await marta.get("/api/merchant/readiness")).json().ready).toBe(true);
    expect((await write("PATCH", "/api/merchant/business", { chatEnabled: true })).json()).toMatchObject({ chatEnabled: true });

    const chat = chatClient(server.app, "barberia-norte");
    const sessionId = await chat.newSession();
    llm.script = [
      call("save_customer_contact", { name: "Luis", phone: "955550199", email: "luis@example.com" }),
      call("hold_slot", { service_id: barba.id, date: "2026-10-13", time: "11:00", party_size: 1 }),
      call("confirm_booking", (p) => ({ booking_id: findInHistory(p, "booking_id").booking_id })),
      say("Listo, Luis: martes a las 11:00 con Tomás."),
    ];
    expect((await chat.send(sessionId, "Barba el martes a las 11, Luis, 955550199, luis@example.com")).reply).toContain("Listo");
    const bookings = (await marta.get("/api/merchant/bookings?from=2026-10-13&to=2026-10-13")).json().items;
    expect(bookings).toEqual([expect.objectContaining({ time: "11:00", status: "confirmed", staff: { id: tomas.id, name: "Tomás" } })]);
  });
});

describe("idioma del usuario", () => {
  it("cada usuario elige su idioma y sus correos llegan en ese idioma", async () => {
    const camila = browser(server.app);
    await camila.signIn(AURORA_USERS.camila.email, DEV_PASSWORD);
    expect((await post(camila, "/api/auth/update-user", { locale: "en" })).statusCode).toBe(200);
    const invalid = await post(camila, "/api/auth/update-user", { locale: "fr" });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ code: "INVALID_LOCALE" });

    await post(browser(server.app), "/api/auth/request-password-reset", { email: AURORA_USERS.camila.email, redirectTo: `${CONSOLE}/restablecer` });
    expect(emails.lastTo(AURORA_USERS.camila.email)!.subject).toBe("Reset your HablaHora password");
    await post(browser(server.app), "/api/auth/request-password-reset", { email: AURORA_USERS.valeria.email, redirectTo: `${CONSOLE}/restablecer` });
    expect(emails.lastTo(AURORA_USERS.valeria.email)!.subject).toBe("Recupera tu contraseña de HablaHora");

    const session = await camila.get("/api/auth/get-session");
    expect(session.json().user.locale).toBe("en");
  });
});

describe("administradores del negocio", () => {
  it("el negocio nunca se queda sin administrador; tampoco se invita como dueño", async () => {
    const valeria = browser(server.app);
    await valeria.signIn(AURORA_USERS.valeria.email, DEV_PASSWORD);
    const orgId = (await valeria.get("/api/me")).json().business.organizationId;
    const members = (await valeria.get(`/api/auth/organization/get-full-organization?organizationId=${orgId}`)).json().members;
    const own = members.find((m: any) => m.user.email === AURORA_USERS.valeria.email);
    const camila = members.find((m: any) => m.user.email === AURORA_USERS.camila.email);

    // la única dueña no puede pasar a staff ni irse: Better Auth exige un dueño, y con él siempre hay un administrador
    const demote = await post(valeria, "/api/auth/organization/update-member-role", { memberId: own.id, role: "member", organizationId: orgId });
    expect(demote.statusCode).toBe(400);
    const leave = await post(valeria, "/api/auth/organization/remove-member", { memberIdOrEmail: own.id, organizationId: orgId });
    expect([400, 403]).toContain(leave.statusCode);
    const stillOwner = await authDb.query(`SELECT role FROM member WHERE id = $1`, [own.id]);
    expect(stillOwner.rows[0].role).toBe("owner");

    // no se invita como dueño
    const asOwner = await post(valeria, "/api/auth/organization/invite-member", { email: "ana@norte.test", role: "owner", organizationId: orgId });
    expect(asOwner.statusCode).toBe(400);
    expect(asOwner.json()).toMatchObject({ code: "INVALID_ROLE" });

    // los demás administradores sí pueden cambiar de rol: la dueña sigue
    expect((await post(valeria, "/api/auth/organization/update-member-role", { memberId: camila.id, role: "admin", organizationId: orgId })).statusCode).toBe(200);
    expect((await post(valeria, "/api/auth/organization/update-member-role", { memberId: camila.id, role: "member", organizationId: orgId })).statusCode).toBe(200)
  });
});
