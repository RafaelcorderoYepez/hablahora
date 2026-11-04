import { Plan, PlatformBusiness, PlatformSettings, PlatformUser } from "@hablahora/contracts";
import { AgentRunner, BookingService, MemoryEmailSender, WebChatProcessor } from "@hablahora/core";
import { AURORA, seedSalonAurora } from "@hablahora/db";
import { DateTime } from "luxon";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAuth } from "../../src/auth.js";
import { AURORA_USERS, DEV_PASSWORD, seedAuroraUsers } from "../../src/seed-users.js";
import { buildServer } from "../../src/server.js";
import { usageNotifier } from "../../src/usage-notify.js";
import { browser, ORIGIN } from "../../../../test/support/auth.js";
import { FAKE_MODEL, FakeLlm, say } from "../../../../test/support/fake-llm.js";
import { ADMIN_URL, APP_URL, AUTH_URL } from "../../../../test/support/global-setup.js";
import { chatClient } from "../../../../test/support/web-chat.js";

/** Consola del owner (H6, parte 1): negocios, planes y límites, modelo, usuarios de la plataforma. */

const NORTE = { name: "Barbería Norte Plataforma", owner: { name: "Marta", email: "marta@norte-plataforma.test" } };

let admin: pg.Pool;
let app: pg.Pool;
let authDb: pg.Pool;
let auth: ReturnType<typeof createAuth>["auth"];
let server: ReturnType<typeof buildServer>;
let chat: ReturnType<typeof chatClient>;
let now: Date;
const llm = new FakeLlm();
const authEmail = new MemoryEmailSender();
const email = new MemoryEmailSender();

beforeAll(async () => {
  admin = new pg.Pool({ connectionString: ADMIN_URL });
  app = new pg.Pool({ connectionString: APP_URL, max: 10 });
  const created = createAuth({
    databaseUrl: AUTH_URL,
    baseURL: ORIGIN,
    secret: "secreto-de-tests-0123456789-0123456789",
    trustedOrigins: [ORIGIN],
    consoleURL: ORIGIN,
    email: authEmail,
  });
  auth = created.auth;
  authDb = created.pool;
  const clock = () => now;
  const runner = new AgentRunner({ db: app, bookings: new BookingService(app, clock), clock, model: FAKE_MODEL, llm: llm.client });
  server = buildServer({
    auth: { auth, authDb, db: app, trustedOrigins: [ORIGIN], clock, consoleURL: ORIGIN, serverModel: FAKE_MODEL },
    webChat: new WebChatProcessor({
      db: app,
      runner,
      clock,
      log: { info() {}, warn() {}, error() {} },
      onUsageWarning: usageNotifier({ db: app, authDb, email, consoleURL: "http://consola.test" }),
    }),
  });
  chat = chatClient(server.app, AURORA.slug);
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
  now = DateTime.fromISO("2026-10-12T12:00", { zone: AURORA.timezone }).toJSDate();
  llm.reset();
  email.sent = [];
  authEmail.sent = [];
});

afterEach(async () => {
  expect(llm.stepErrors).toEqual([]);
  // lo global vuelve a como lo deja la migración (los demás archivos de tests lo comparten)
  await removeBusiness(NORTE.name, NORTE.owner.email);
  await admin.query("UPDATE platform_settings SET default_model = NULL");
  await admin.query("UPDATE plans SET is_default = false WHERE name <> 'Inicial'");
  await admin.query("UPDATE plans SET is_default = true WHERE name = 'Inicial'");
  await admin.query("UPDATE plans SET max_conversations_per_month = 300, max_active_staff = 3 WHERE name = 'Inicial'");
  await admin.query("UPDATE tenants SET plan_id = (SELECT id FROM plans WHERE is_default) WHERE plan_id NOT IN (SELECT id FROM plans WHERE name IN ('Inicial', 'Profesional'))");
  await admin.query("DELETE FROM plans WHERE name NOT IN ('Inicial', 'Profesional')");
  await authDb.query(`DELETE FROM "user" WHERE email LIKE '%@plataforma-hh.test'`);
});

async function removeBusiness(name: string, ownerEmail: string) {
  const { rows } = await admin.query("SELECT id, auth_organization_id FROM tenants WHERE name = $1", [name]);
  for (const t of rows) {
    for (const table of ["service_resources", "services", "availability_rules", "resources", "booking_policies", "locations"]) {
      await admin.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [t.id]);
    }
    await admin.query("DELETE FROM tenants WHERE id = $1", [t.id]);
    await authDb.query("DELETE FROM organization WHERE id = $1", [t.auth_organization_id]);
  }
  await authDb.query(`DELETE FROM "user" WHERE email = $1`, [ownerEmail]);
}

const as = async (who: keyof typeof AURORA_USERS) => {
  const b = browser(server.app);
  expect((await b.signIn(AURORA_USERS[who].email, DEV_PASSWORD)).statusCode).toBe(200);
  const write = (method: "POST" | "PATCH" | "PUT" | "DELETE", url: string, payload?: unknown, origin: string | null = ORIGIN) =>
    server.app.inject({
      method,
      url,
      ...(payload !== undefined ? { payload: payload as any } : {}),
      headers: { cookie: b.cookie, ...(origin ? { origin } : {}) },
    });
  return { ...b, write };
};
const platformAdmin = () => as("platformAdmin");

const planId = async (name: string) => (await admin.query("SELECT id FROM plans WHERE name = $1", [name])).rows[0].id as string;
const aurora = async (p: Awaited<ReturnType<typeof platformAdmin>>) =>
  PlatformBusiness.parse((await p.get(`/api/platform/businesses/${AURORA.tenant}`)).json());

/** Conversación con un mensaje del cliente en el mes (cuenta para el plan). */
async function pastConversation() {
  const { rows } = await admin.query(
    `INSERT INTO conversations (tenant_id, location_id, channel, external_id, created_at)
     VALUES ($1, $2, 'web', gen_random_uuid()::text, $3) RETURNING id`,
    [AURORA.tenant, AURORA.location, new Date(now.getTime() - 3_600_000)],
  );
  await admin.query(
    `INSERT INTO conversation_messages (tenant_id, conversation_id, role, content, author) VALUES ($1, $2, 'user', '[{"type":"text","text":"hola"}]', 'customer')`,
    [AURORA.tenant, rows[0].id],
  );
}

// ---------------------------------------------------------------------

describe("permisos", () => {
  it("solo el administrador de plataforma, y las escrituras desde la consola", async () => {
    expect((await server.app.inject({ url: "/api/platform/businesses" })).statusCode).toBe(401);
    const valeria = await as("valeria");
    expect((await valeria.get("/api/platform/businesses")).statusCode).toBe(403);
    expect((await valeria.write("PATCH", `/api/platform/businesses/${AURORA.tenant}`, { status: "suspended" })).statusCode).toBe(403);

    const p = await platformAdmin();
    expect((await p.get("/api/platform/businesses")).statusCode).toBe(200);
    expect((await p.write("PATCH", `/api/platform/businesses/${AURORA.tenant}`, { status: "suspended" }, null)).statusCode).toBe(403);
  });
});

describe("negocios", () => {
  it("listado con plan, dueño y uso del mes", async () => {
    await pastConversation();
    const p = await platformAdmin();
    const list = (await p.get("/api/platform/businesses")).json().map((b: unknown) => PlatformBusiness.parse(b));
    expect(list.find((b: PlatformBusiness) => b.id === AURORA.tenant)).toMatchObject({
      name: "Salón Aurora",
      status: "active",
      plan: { name: "Profesional" },
      agentModel: null,
      slug: AURORA.slug,
      chatEnabled: true,
      owner: { name: AURORA_USERS.valeria.name, email: AURORA_USERS.valeria.email },
      usage: { conversationsThisMonth: 1, maxConversationsPerMonth: 1500, activeStaff: 3, maxActiveStaff: 10 },
    });
  });

  it("alta con plantilla: dueño con correo de bienvenida, horario, servicios y el dueño como profesional", async () => {
    const p = await platformAdmin();
    const res = await p.write("POST", "/api/platform/businesses", {
      name: NORTE.name,
      template: "barberia",
      owner: NORTE.owner,
      timezone: "America/Chicago",
      locale: "es",
      planId: await planId("Inicial"),
    });
    expect(res.statusCode).toBe(201);
    const b = PlatformBusiness.parse(res.json());
    expect(b).toMatchObject({
      name: NORTE.name,
      vertical: "barbershop",
      status: "active",
      plan: { name: "Inicial" },
      chatEnabled: false,
      owner: NORTE.owner,
      usage: { activeStaff: 1, maxActiveStaff: 3 },
    });
    const welcome = authEmail.lastTo(NORTE.owner.email)!;
    expect(welcome.subject).toBe("Bienvenido a HablaHora: crea tu contraseña");
    expect(welcome.text).toContain(encodeURIComponent(`${ORIGIN}/restablecer`));

    const services = await admin.query("SELECT name FROM services WHERE tenant_id = $1 ORDER BY name", [b.id]);
    expect(services.rows.map((r) => r.name)).toEqual(["Barba", "Corte", "Corte y barba"]);
    const staff = await admin.query("SELECT name FROM resources WHERE tenant_id = $1", [b.id]);
    expect(staff.rows).toEqual([{ name: "Marta" }]);
    const rules = await admin.query("SELECT count(*)::int AS n FROM availability_rules WHERE tenant_id = $1", [b.id]);
    expect(rules.rows[0].n).toBe(6); // lunes a sábado
    const links = await admin.query(
      "SELECT count(*)::int AS n FROM service_resources sr JOIN services s ON s.id = sr.service_id WHERE s.tenant_id = $1",
      [b.id],
    );
    expect(links.rows[0].n).toBe(3);

    expect((await p.write("POST", "/api/platform/businesses", { name: "X", template: "spa", owner: NORTE.owner })).statusCode).toBe(400);
  });

  it("país: Chile por defecto (pesos, Santiago, español); EE.UU. con dólares y Nueva York; la plantilla en su moneda", async () => {
    const p = await platformAdmin();
    const create = async (body: Record<string, unknown>) => {
      const res = await p.write("POST", "/api/platform/businesses", { template: "salon", ...body });
      expect(res.statusCode).toBe(201);
      const b = PlatformBusiness.parse(res.json());
      const loc = await admin.query("SELECT timezone, default_locale FROM locations WHERE tenant_id = $1", [b.id]);
      const prices = await admin.query("SELECT name, price FROM services WHERE tenant_id = $1 ORDER BY name", [b.id]);
      return { b, loc: loc.rows[0], prices: Object.fromEntries(prices.rows.map((r) => [r.name, r.price])) };
    };

    const cl = await create({ name: "Peluquería Ñuñoa", owner: { name: "Rosa", email: "rosa@plataforma-hh.test" } });
    expect(cl.b).toMatchObject({ country: "CL", currency: "CLP" });
    expect(cl.loc).toEqual({ timezone: "America/Santiago", default_locale: "es" });
    expect(cl.prices).toMatchObject({ "Corte de mujer": 18000, Color: 45000 }); // pesos

    const us = await create({ name: "Salon Miami", country: "US", owner: { name: "Ann", email: "ann@plataforma-hh.test" } });
    expect(us.b).toMatchObject({ country: "US", currency: "USD" });
    expect(us.loc).toEqual({ timezone: "America/New_York", default_locale: "en" });
    expect(us.prices).toMatchObject({ "Corte de mujer": 5500, Color: 12000 }); // centavos

    // un país que no está soportado no entra
    const bad = await p.write("POST", "/api/platform/businesses", { name: "X", template: "salon", country: "AR", owner: NORTE.owner });
    expect(bad.statusCode).toBe(400);
  });

  it("suspender: el chat no atiende y la consola del negocio queda en solo lectura; reactivar lo devuelve", async () => {
    const open = await chat.newSession();
    const p = await platformAdmin();
    const suspended = PlatformBusiness.parse(
      (await p.write("PATCH", `/api/platform/businesses/${AURORA.tenant}`, { status: "suspended" })).json(),
    );
    expect(suspended).toMatchObject({ status: "suspended", statusChangedAt: now.toISOString() });

    expect((await server.app.inject({ url: `/api/chat/${AURORA.slug}` })).json()).toMatchObject({ available: false });
    expect((await server.app.inject({ method: "POST", url: `/api/chat/${AURORA.slug}/sessions` })).statusCode).toBe(409);
    expect((await chat.send(open, "Hola")).res.statusCode).toBe(409);

    const valeria = await as("valeria");
    expect((await valeria.get("/api/me")).json().business).toMatchObject({ status: "suspended" });
    expect((await valeria.get("/api/merchant/business")).statusCode).toBe(200);
    const write = await valeria.write("PATCH", "/api/merchant/business", { address: "Otra" });
    expect(write.statusCode).toBe(403);
    expect(write.json()).toMatchObject({ reason: "business_suspended" });

    await p.write("PATCH", `/api/platform/businesses/${AURORA.tenant}`, { status: "active" });
    expect((await server.app.inject({ url: `/api/chat/${AURORA.slug}` })).json()).toMatchObject({ available: true });
    expect((await valeria.write("PATCH", "/api/merchant/business", { address: "Otra" })).statusCode).toBe(200);
  });

  it("dar de baja: sin chat y sin acceso a la consola del negocio; los datos quedan", async () => {
    const p = await platformAdmin();
    await p.write("PATCH", `/api/platform/businesses/${AURORA.tenant}`, { status: "closed" });
    const valeria = await as("valeria");
    const res = await valeria.get("/api/merchant/business");
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ reason: "business_closed" });
    expect((await server.app.inject({ url: `/api/chat/${AURORA.slug}` })).json()).toMatchObject({ available: false });
    const services = await admin.query("SELECT count(*)::int AS n FROM services WHERE tenant_id = $1", [AURORA.tenant]);
    expect(services.rows[0].n).toBeGreaterThan(0);
  });
});

describe("límites del plan", () => {
  it("profesionales activos: no deja agregar ni reactivar por encima del plan", async () => {
    const p = await platformAdmin();
    await p.write("PATCH", `/api/platform/businesses/${AURORA.tenant}`, { planId: await planId("Inicial") }); // 3, ya tiene 3
    const valeria = await as("valeria");
    const res = await valeria.write("POST", "/api/merchant/staff", { name: "Lucía", serviceIds: [], active: true });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ reason: "plan_limit_staff" });

    const inactive = await valeria.write("POST", "/api/merchant/staff", { name: "Lucía", serviceIds: [], active: false });
    expect(inactive.statusCode).toBe(201);
    const activate = await valeria.write("PATCH", `/api/merchant/staff/${inactive.json().id}`, { active: true });
    expect(activate.json()).toMatchObject({ reason: "plan_limit_staff" });
    // desactivar a otro libera el lugar
    await valeria.write("PATCH", `/api/merchant/staff/${AURORA.staff.diego}`, { active: false });
    expect((await valeria.write("PATCH", `/api/merchant/staff/${inactive.json().id}`, { active: true })).statusCode).toBe(200);
  });

  it("conversaciones del mes: aviso al 80 % (una vez) y al 100 % no abre nuevas; las abiertas siguen", async () => {
    const p = await platformAdmin();
    const mini = Plan.parse(
      (await p.write("POST", "/api/platform/plans", { name: "Mini", maxConversationsPerMonth: 5, maxActiveStaff: null })).json(),
    );
    await p.write("PATCH", `/api/platform/businesses/${AURORA.tenant}`, { planId: mini.id });
    for (let i = 0; i < 3; i++) await pastConversation();

    // la cuarta llega al 80 %: avisa a la dueña y a la plataforma
    const fourth = await chat.newSession();
    expect(email.sent.map((m) => m.to).sort()).toEqual([AURORA_USERS.platformAdmin.email, AURORA_USERS.valeria.email].sort());
    expect(email.lastTo(AURORA_USERS.valeria.email)!.subject).toBe("Salón Aurora: se usó el 80 % de las conversaciones del mes");
    expect(email.lastTo(AURORA_USERS.platformAdmin.email)!.text).toContain("http://consola.test/plataforma");
    llm.script = [say("¡Hola!")];
    await chat.send(fourth, "Hola");

    // la quinta no vuelve a avisar
    const fifth = await chat.newSession();
    expect(email.sent).toHaveLength(2);
    llm.script = [say("¡Hola!")];
    await chat.send(fifth, "Hola");

    // al límite: no abre nuevas, pero la abierta sigue respondiendo
    expect((await server.app.inject({ method: "POST", url: `/api/chat/${AURORA.slug}/sessions` })).statusCode).toBe(409);
    llm.script = [say("Sigo aquí.")];
    expect((await chat.send(fifth, "¿Sigues?")).reply).toBe("Sigo aquí.");

    expect((await aurora(p)).usage).toMatchObject({ conversationsThisMonth: 5, maxConversationsPerMonth: 5 });
  });
});

describe("modelo del agente", () => {
  it("el del negocio, si no el de la plataforma, si no el del servidor; queda en llm_usage", async () => {
    const p = await platformAdmin();
    const model = async () => {
      const s = await chat.newSession();
      llm.script = [say("Hola")];
      await chat.send(s, "Hola");
      return llm.calls.at(-1)!.model;
    };
    expect(await model()).toBe(FAKE_MODEL);

    const settings = PlatformSettings.parse((await p.write("PUT", "/api/platform/settings", { defaultModel: "claude-opus-5-5" })).json());
    expect(settings).toMatchObject({ defaultModel: "claude-opus-5-5", serverModel: FAKE_MODEL });
    expect(await model()).toBe("claude-opus-5-5");

    const b = PlatformBusiness.parse(
      (await p.write("PATCH", `/api/platform/businesses/${AURORA.tenant}`, { agentModel: "claude-haiku-5-5" })).json(),
    );
    expect(b.agentModel).toBe("claude-haiku-5-5");
    expect(await model()).toBe("claude-haiku-5-5");
    const usage = await admin.query("SELECT model FROM llm_usage WHERE tenant_id = $1 ORDER BY id DESC LIMIT 1", [AURORA.tenant]);
    expect(usage.rows[0].model).toBe("claude-haiku-5-5");

    expect((await p.write("PATCH", `/api/platform/businesses/${AURORA.tenant}`, { agentModel: "gpt-5" })).statusCode).toBe(400);
    await p.write("PATCH", `/api/platform/businesses/${AURORA.tenant}`, { agentModel: null });
    expect(await model()).toBe("claude-opus-5-5");
  });
});

describe("planes", () => {
  it("crear, nombre repetido, por defecto (uno solo) y borrar solo si nadie lo usa", async () => {
    const p = await platformAdmin();
    const created = Plan.parse(
      (await p.write("POST", "/api/platform/plans", { name: "Empresa", maxConversationsPerMonth: null, maxActiveStaff: 50, isDefault: true })).json(),
    );
    expect(created).toMatchObject({ isDefault: true, maxConversationsPerMonth: null, businesses: 0 });
    const plans = (await p.get("/api/platform/plans")).json().map((x: unknown) => Plan.parse(x));
    expect(plans.filter((x: Plan) => x.isDefault).map((x: Plan) => x.name)).toEqual(["Empresa"]);

    expect((await p.write("POST", "/api/platform/plans", { name: "Empresa", maxConversationsPerMonth: 1, maxActiveStaff: 1 })).json()).toMatchObject({
      reason: "plan_name_taken",
    });
    // en uso (Aurora tiene Profesional) o por defecto: no se borra
    expect((await p.write("DELETE", `/api/platform/plans/${await planId("Profesional")}`)).json()).toMatchObject({ reason: "plan_in_use" });
    expect((await p.write("DELETE", `/api/platform/plans/${created.id}`)).json()).toMatchObject({ reason: "plan_in_use" });
    // Inicial ya no es el por defecto y no lo usa nadie aquí... salvo los negocios de otros archivos: se crea uno libre
    const free = Plan.parse((await p.write("POST", "/api/platform/plans", { name: "Prueba", maxConversationsPerMonth: 10, maxActiveStaff: 1 })).json());
    expect((await p.write("DELETE", `/api/platform/plans/${free.id}`)).statusCode).toBe(204);

    const edited = Plan.parse(
      (await p.write("PUT", `/api/platform/plans/${created.id}`, { name: "Empresa", maxConversationsPerMonth: 5000, maxActiveStaff: 50, isDefault: false })).json(),
    );
    expect(edited).toMatchObject({ maxConversationsPerMonth: 5000, isDefault: true }); // siempre queda un plan por defecto
  });
});

describe("usuarios de la plataforma", () => {
  it("invitar (correo para crear la contraseña), repetido, y quitar el acceso (no a uno mismo)", async () => {
    const p = await platformAdmin();
    const res = await p.write("POST", "/api/platform/users", { name: "Sofía", email: "sofia@plataforma-hh.test" });
    expect(res.statusCode).toBe(201);
    const users = res.json().map((u: unknown) => PlatformUser.parse(u));
    expect(users.map((u: PlatformUser) => u.email)).toContain("sofia@plataforma-hh.test");
    const invite = authEmail.lastTo("sofia@plataforma-hh.test")!;
    expect(invite.subject).toBe("Te invitaron a administrar HablaHora");
    expect(invite.text).toContain(encodeURIComponent(`${ORIGIN}/restablecer`));
    expect((await p.write("POST", "/api/platform/users", { name: "Sofía", email: "SOFIA@plataforma-hh.test" })).json()).toMatchObject({
      reason: "user_exists",
    });

    const me = users.find((u: PlatformUser) => u.email === AURORA_USERS.platformAdmin.email)!;
    expect((await p.write("DELETE", `/api/platform/users/${me.id}`)).json()).toMatchObject({ reason: "last_platform_admin" });
    const sofia = users.find((u: PlatformUser) => u.email === "sofia@plataforma-hh.test")!;
    const after = (await p.write("DELETE", `/api/platform/users/${sofia.id}`)).json();
    expect(after.map((u: PlatformUser) => u.email)).not.toContain("sofia@plataforma-hh.test");
  });
});
