import { ConversationDetail, ConversationPage, PlatformHealth, PlatformOverview, PlatformUsage, SupportLogPage } from "@hablahora/contracts";
import { BookingService, MemoryEmailSender } from "@hablahora/core";
import { AURORA, seedSalonAurora } from "@hablahora/db";
import { DateTime } from "luxon";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAuth } from "../../src/auth.js";
import { AURORA_USERS, DEV_PASSWORD, seedAuroraUsers } from "../../src/seed-users.js";
import { buildServer } from "../../src/server.js";
import { browser, ORIGIN } from "../../../../test/support/auth.js";
import { ADMIN_URL, APP_URL, AUTH_URL } from "../../../../test/support/global-setup.js";

/** Consola del owner (H6, parte 2): panel, uso y costo, salud, soporte con registro y usuarios bloqueados. */

const NOW = DateTime.fromISO("2026-10-12T16:00:00Z").toJSDate(); // 12:00 en Nueva York
const at = (iso: string) => new Date(iso);
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);
const OTHER = { tenant: "d1d1d1d1-0000-4000-8000-000000000001", location: "d1d1d1d1-0000-4000-8000-000000000002", conv: "d1d1d1d1-0000-4000-8000-000000000003" };

let admin: pg.Pool;
let app: pg.Pool;
let authDb: pg.Pool;
let auth: ReturnType<typeof createAuth>["auth"];
let server: ReturnType<typeof buildServer>;
const emails = new MemoryEmailSender();

beforeAll(async () => {
  admin = new pg.Pool({ connectionString: ADMIN_URL });
  app = new pg.Pool({ connectionString: APP_URL, max: 10 });
  const created = createAuth({
    databaseUrl: AUTH_URL,
    baseURL: ORIGIN,
    secret: "secreto-de-tests-0123456789-0123456789",
    trustedOrigins: [ORIGIN],
    consoleURL: "http://consola.test",
    email: emails,
  });
  auth = created.auth;
  authDb = created.pool;
  server = buildServer({
    auth: { auth, authDb, db: app, trustedOrigins: [ORIGIN], clock: () => NOW, bookings: new BookingService(app, () => NOW), consoleURL: ORIGIN },
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
  emails.sent = [];
});

afterEach(async () => {
  await removeOther();
  await authDb.query(`DELETE FROM "user" WHERE email LIKE '%@ops-hh.test'`);
});

async function removeOther() {
  for (const t of ["support_access_log", "tool_calls", "llm_usage", "conversation_messages", "conversations", "locations"]) {
    await admin.query(`DELETE FROM ${t} WHERE tenant_id = $1`, [OTHER.tenant]);
  }
  await admin.query("DELETE FROM tenants WHERE id = $1", [OTHER.tenant]);
}

const as = async (who: keyof typeof AURORA_USERS) => {
  const b = browser(server.app);
  expect((await b.signIn(AURORA_USERS[who].email, DEV_PASSWORD)).statusCode).toBe(200);
  return b;
};
const orgId = async () => (await authDb.query("SELECT id FROM organization WHERE slug = $1", [AURORA.slug])).rows[0].id as string;
const setStatus = (status: string) => admin.query("UPDATE tenants SET status = $2 WHERE id = $1", [AURORA.tenant, status]);

/** Conversación de Aurora con (o sin) mensaje del cliente. */
async function conversation(createdAt: Date, a: { customer?: boolean; handoffAt?: Date; staffReplyAt?: Date } = {}): Promise<string> {
  const { rows } = await admin.query(
    `INSERT INTO conversations (tenant_id, location_id, channel, external_id, handoff, handoff_at, handoff_reason, created_at)
     VALUES ($1, $2, 'web', gen_random_uuid()::text, $3, $4, $5, $6) RETURNING id`,
    [AURORA.tenant, AURORA.location, !!a.handoffAt, a.handoffAt ?? null, a.handoffAt ? "Quiere un presupuesto" : null, createdAt],
  );
  const msg = (author: string, role: string, when: Date) =>
    admin.query(
      `INSERT INTO conversation_messages (tenant_id, conversation_id, role, content, author, created_at)
       VALUES ($1, $2, $3, '[{"type":"text","text":"hola"}]', $4, $5)`,
      [AURORA.tenant, rows[0].id, role, author, when],
    );
  if (a.customer !== false) await msg("customer", "user", createdAt);
  if (a.staffReplyAt) await msg("staff", "assistant", a.staffReplyAt);
  return rows[0].id;
}

async function llmCall(convId: string, when: Date, a: { ms: number; input?: number; output?: number; read?: number; write?: number; cost?: number | null; error?: string; model?: string }) {
  const { rows } = await admin.query(
    `INSERT INTO llm_usage (tenant_id, location_id, conversation_id, channel, turn_id, model, input_tokens, output_tokens,
                            cache_read_input_tokens, cache_creation_input_tokens, cost_usd, duration_ms, error, created_at)
     VALUES ($1, $2, $3, 'web', gen_random_uuid(), $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
    [AURORA.tenant, AURORA.location, convId, a.model ?? "claude-sonnet-5-5", a.input ?? 0, a.output ?? 0, a.read ?? 0, a.write ?? 0, a.cost ?? null, a.ms, a.error ?? null, when],
  );
  return rows[0].id as string;
}

async function toolCall(convId: string, llmId: string, when: Date, name: string, isError: boolean) {
  await admin.query(
    `INSERT INTO tool_calls (tenant_id, conversation_id, llm_usage_id, tool_use_id, name, input, result, is_error, duration_ms, created_at)
     VALUES ($1, $2, $3, gen_random_uuid()::text, $4, '{}', '{}', $5, 10, $6)`,
    [AURORA.tenant, convId, llmId, name, isError, when],
  );
}

/** Datos conocidos del Salón Aurora para el panel, el uso y la salud. */
async function seedActivity() {
  const a = await conversation(at("2026-10-10T15:00:00Z"));
  const b = await conversation(at("2026-10-11T15:00:00Z"), { handoffAt: minutesAgo(30) }); // sin respuesta del equipo hace 30 min
  await conversation(at("2026-10-11T16:00:00Z"), { handoffAt: minutesAgo(30), staffReplyAt: minutesAgo(20) }); // atendida
  await conversation(at("2026-10-12T15:55:00Z"), { handoffAt: minutesAgo(5) }); // aún dentro del plazo
  await conversation(at("2026-10-12T15:00:00Z"), { customer: false }); // sin mensajes del cliente: no cuenta
  await conversation(at("2026-09-01T15:00:00Z")); // otro mes

  await llmCall(a, at("2026-10-10T15:01:00Z"), { ms: 1000, input: 100, output: 10, cost: 0.01 });
  await llmCall(a, at("2026-10-10T15:02:00Z"), { ms: 2000, input: 200, output: 20, read: 50, cost: 0.02 });
  const third = await llmCall(a, at("2026-10-10T15:03:00Z"), { ms: 3000, input: 300, output: 30, write: 25, cost: 0.03 });
  await llmCall(a, at("2026-10-10T15:04:00Z"), { ms: 1500, input: 40, output: 4, cost: null, model: "otro-modelo" });
  await llmCall(b, at("2026-10-10T15:05:00Z"), { ms: 500, error: "API caída" });
  await toolCall(a, third, at("2026-10-10T15:03:30Z"), "list_services", false);
  await toolCall(a, third, at("2026-10-10T15:03:31Z"), "list_services", false);
  await toolCall(a, third, at("2026-10-10T15:03:32Z"), "hold_slot", true);

  const customer = (await admin.query(`INSERT INTO customers (tenant_id, name, phone_e164) VALUES ($1, 'Rosa', '+13055550001') RETURNING id`, [AURORA.tenant])).rows[0].id;
  const booking = (status: string, createdAt: Date) =>
    admin.query(
      `INSERT INTO bookings (tenant_id, location_id, service_id, customer_id, starts_at, ends_at, status, source, created_at)
       VALUES ($1, $2, $3, $4, '2026-10-14T14:00:00Z', '2026-10-14T15:00:00Z', $5, 'web', $6)`,
      [AURORA.tenant, AURORA.location, AURORA.services.corteMujer, customer, status, createdAt],
    );
  await booking("confirmed", at("2026-10-11T15:30:00Z"));
  await booking("hold", at("2026-10-11T15:31:00Z")); // un apartado no cuenta
  return { a, b };
}

// ---------------------------------------------------------------------

describe("panel general", () => {
  it("negocios por estado y conversaciones, reservas y errores por día (UTC)", async () => {
    await seedActivity();
    await setStatus("suspended");
    const p = await as("platformAdmin");
    const o = PlatformOverview.parse((await p.get("/api/platform/overview?days=7")).json());

    const byStatus = (await admin.query("SELECT status, count(*)::int AS n FROM tenants GROUP BY status")).rows;
    const n = (s: string) => byStatus.find((r) => r.status === s)?.n ?? 0;
    expect(o.businesses).toEqual({ total: byStatus.reduce((t, r) => t + r.n, 0), active: n("active"), suspended: n("suspended"), closed: n("closed") });
    expect(o.businesses.suspended).toBe(1);

    expect([o.from, o.to, o.days]).toEqual([
      "2026-10-06",
      "2026-10-12",
      expect.any(Array),
    ]);
    expect(o.days.filter((d) => d.conversations || d.bookings || d.errors)).toEqual([
      { date: "2026-10-10", conversations: 1, bookings: 0, errors: 2 }, // la llamada fallida y la herramienta que falló
      { date: "2026-10-11", conversations: 2, bookings: 1, errors: 0 },
      { date: "2026-10-12", conversations: 1, bookings: 0, errors: 0 },
    ]);
    expect(o.totals).toEqual({ conversations: 4, bookings: 1, errors: 2 });
    expect((await p.get("/api/platform/overview?days=15")).statusCode).toBe(400);
  });
});

describe("uso y costo", () => {
  it("tokens y costo del mes por negocio, contra el plan; las llamadas sin precio se avisan", async () => {
    await seedActivity();
    const p = await as("platformAdmin");
    const u = PlatformUsage.parse((await p.get("/api/platform/usage?month=2026-10")).json());
    const aurora = u.businesses.find((b) => b.id === AURORA.tenant)!;
    expect(aurora).toMatchObject({
      name: "Salón Aurora",
      plan: { name: "Profesional" },
      conversations: 4,
      maxConversationsPerMonth: 1500,
      llmCalls: 5,
      inputTokens: 640,
      outputTokens: 64,
      cacheReadTokens: 50,
      cacheWriteTokens: 25,
      costUsd: 0.06,
      costPerConversationUsd: 0.015,
      unpricedCalls: 1,
    });
    expect(u.totals.costUsd).toBeGreaterThanOrEqual(0.06);
    expect(u.businesses[0].costUsd).toBeGreaterThanOrEqual(u.businesses.at(-1)!.costUsd); // el que más gasta, primero

    // el mes anterior solo tiene la conversación de septiembre
    const sept = PlatformUsage.parse((await p.get("/api/platform/usage?month=2026-09")).json());
    expect(sept.businesses.find((b) => b.id === AURORA.tenant)).toMatchObject({ conversations: 1, llmCalls: 0, costUsd: 0, costPerConversationUsd: 0 });
    // sin mes, el actual
    expect(PlatformUsage.parse((await p.get("/api/platform/usage")).json()).month).toBe("2026-10");
    expect((await p.get("/api/platform/usage?month=2026-13")).statusCode).toBe(400);
  });
});

describe("salud", () => {
  it("latencia, errores del modelo y de herramientas, y conversaciones desatendidas", async () => {
    const { b } = await seedActivity();
    const p = await as("platformAdmin");
    const h = PlatformHealth.parse((await p.get("/api/platform/health")).json());
    expect(h).toMatchObject({ windowDays: 7, waitThresholdMin: 15 });
    expect(h.agent).toMatchObject({ calls: 5, errors: 1, errorRate: 0.2, p50Ms: 1500, p95Ms: 3000 });
    expect(h.tools).toMatchObject({ calls: 3, errors: 1 });
    expect(h.tools.failing).toEqual([{ name: "hold_slot", calls: 1, errors: 1 }]);
    expect(h.waiting).toEqual([
      { tenantId: AURORA.tenant, tenantName: "Salón Aurora", conversationId: b, waitingMin: 30, reason: "Quiere un presupuesto" },
    ]);
    expect(h.byBusiness.find((x) => x.id === AURORA.tenant)).toMatchObject({ calls: 5, errors: 1, p95Ms: 3000 });
  });

  it("sin datos: ceros y sin latencia", async () => {
    const p = await as("platformAdmin");
    const h = PlatformHealth.parse((await p.get("/api/platform/health")).json());
    expect(h.agent).toMatchObject({ calls: 0, errors: 0, errorRate: 0, p50Ms: null, p95Ms: null });
    expect(h.waiting).toEqual([]);
  });
});

describe("soporte", () => {
  async function otherBusinessConversation() {
    await admin.query(`INSERT INTO tenants (id, name, vertical) VALUES ($1, 'Otro Negocio', 'salon')`, [OTHER.tenant]);
    await admin.query(`INSERT INTO locations (id, tenant_id, name, timezone) VALUES ($1, $2, 'X', 'UTC')`, [OTHER.location, OTHER.tenant]);
    await admin.query(`INSERT INTO conversations (id, tenant_id, location_id, channel, external_id) VALUES ($1, $2, $3, 'web', 'otra')`, [OTHER.conv, OTHER.tenant, OTHER.location]);
    await admin.query(
      `INSERT INTO conversation_messages (tenant_id, conversation_id, role, content, author) VALUES ($1, $2, 'user', '[{"type":"text","text":"secreto"}]', 'customer')`,
      [OTHER.tenant, OTHER.conv],
    );
  }

  it("sin motivo no se entra; con motivo se ve el listado y el detalle, y cada acceso queda registrado", async () => {
    const { a } = await seedActivity();
    const p = await as("platformAdmin");
    const url = `/api/platform/support/businesses/${AURORA.tenant}/conversations`;

    expect((await p.post(url, {})).statusCode).toBe(400);
    expect((await p.post(url, { reason: "ya" })).statusCode).toBe(400);
    expect((await p.post(url, { reason: "     " })).statusCode).toBe(400);
    expect((await admin.query("SELECT count(*)::int AS n FROM support_access_log")).rows[0].n).toBe(0);

    const page1 = ConversationPage.parse((await p.post(url, { reason: "Ticket 123: el cliente no puede reservar", limit: 2 })).json());
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();
    // la página siguiente es el mismo acceso: no se registra de nuevo
    await p.post(url, { reason: "Ticket 123: el cliente no puede reservar", limit: 2, cursor: page1.nextCursor });
    expect((await admin.query("SELECT count(*)::int AS n FROM support_access_log")).rows[0].n).toBe(1);

    const detail = ConversationDetail.parse((await p.post(`${url}/${a}`, { reason: "Ticket 123: revisar traza" })).json());
    expect(detail.trace.llmCalls.flatMap((c) => c.toolCalls.map((t) => t.name))).toEqual(["list_services", "list_services", "hold_slot"]);
    expect(detail.trace.llmCalls[0]).not.toHaveProperty("costUsd");

    const log = SupportLogPage.parse((await p.get("/api/platform/support/log")).json());
    expect(log.items.map((i) => [i.business.name, i.conversationId, i.reason])).toEqual([
      ["Salón Aurora", a, "Ticket 123: revisar traza"],
      ["Salón Aurora", null, "Ticket 123: el cliente no puede reservar"],
    ]);
    expect(log.items[0].user).toEqual({ id: expect.any(String), name: AURORA_USERS.platformAdmin.name, email: AURORA_USERS.platformAdmin.email });
    expect(log.nextCursor).toBeNull();

    // paginación y filtro por negocio
    const first = SupportLogPage.parse((await p.get("/api/platform/support/log?limit=1")).json());
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).toBe(String(first.items[0].id));
    expect(SupportLogPage.parse((await p.get(`/api/platform/support/log?businessId=${OTHER.tenant}`)).json()).items).toEqual([]);
  });

  it("solo lectura y aislado: no ve conversaciones de otro negocio ni se registra ese intento", async () => {
    await seedActivity();
    await otherBusinessConversation();
    const p = await as("platformAdmin");
    const reason = "Ticket 456: soporte";
    const wrong = await p.post(`/api/platform/support/businesses/${AURORA.tenant}/conversations/${OTHER.conv}`, { reason });
    expect(wrong.statusCode).toBe(404);
    expect((await admin.query("SELECT count(*)::int AS n FROM support_access_log")).rows[0].n).toBe(0);

    // el listado de cada negocio es solo el suyo
    const other = ConversationPage.parse((await p.post(`/api/platform/support/businesses/${OTHER.tenant}/conversations`, { reason })).json());
    expect(other.items.map((c) => c.id)).toEqual([OTHER.conv]);
    expect((await p.post("/api/platform/support/businesses/00000000-0000-4000-8000-000000000000/conversations", { reason })).statusCode).toBe(404);
    // no hay rutas para responder o tomar desde aquí
    expect((await p.post(`/api/merchant/conversations/${OTHER.conv}/reply`, { text: "hola" })).statusCode).toBe(403);
  });

  it("permisos: solo la plataforma, desde un origen de confianza", async () => {
    const valeria = await as("valeria");
    for (const path of ["/api/platform/overview", "/api/platform/usage", "/api/platform/health", "/api/platform/support/log"]) {
      expect((await valeria.get(path)).statusCode).toBe(403);
      expect((await server.app.inject({ url: path })).statusCode).toBe(401);
    }
    expect((await valeria.post(`/api/platform/support/businesses/${AURORA.tenant}/conversations`, { reason: "intento de acceso" })).statusCode).toBe(403);
    const p = await as("platformAdmin");
    const noOrigin = await server.app.inject({
      method: "POST",
      url: `/api/platform/support/businesses/${AURORA.tenant}/conversations`,
      payload: { reason: "sin origen de la consola" },
      headers: { cookie: p.cookie },
    });
    expect(noOrigin.statusCode).toBe(403);
    expect((await admin.query("SELECT count(*)::int AS n FROM support_access_log")).rows[0].n).toBe(0);
  });
});

describe("usuarios del negocio según su estado", () => {
  const invite = (b: ReturnType<typeof browser>, organizationId: string, email = "nuevo@ops-hh.test") =>
    b.post("/api/auth/organization/invite-member", { email, role: "member", organizationId });

  it("suspendido: no se invita, ni cambian roles, ni se quita a nadie, ni se renombra; al reactivar vuelve", async () => {
    const valeria = await as("valeria");
    const organizationId = await orgId();
    const camila = (await authDb.query(`SELECT m.id FROM member m JOIN "user" u ON u.id = m."userId" WHERE u.email = $1`, [AURORA_USERS.camila.email])).rows[0].id;
    const pending = await invite(valeria, organizationId, "pendiente@ops-hh.test");
    expect(pending.statusCode).toBe(200);
    const invitationId = (await authDb.query(`SELECT id FROM invitation WHERE email = 'pendiente@ops-hh.test'`)).rows[0].id;

    const members = async () => (await authDb.query(`SELECT count(*)::int AS n FROM member WHERE "organizationId" = $1`, [organizationId])).rows[0].n as number;
    const before = await members();
    await setStatus("suspended");
    const blocked = [
      await invite(valeria, organizationId),
      await valeria.post("/api/auth/organization/update-member-role", { memberId: camila, role: "admin", organizationId }),
      await valeria.post("/api/auth/organization/remove-member", { memberIdOrEmail: camila, organizationId }),
      await valeria.post("/api/auth/organization/cancel-invitation", { invitationId }),
      await valeria.post("/api/auth/organization/update", { organizationId, data: { name: "Otro nombre" } }),
    ];
    for (const [i, res] of blocked.entries()) {
      expect(res.statusCode, `acción ${i}: ${res.body}`).toBe(403);
      expect(res.json()).toMatchObject({ code: "BUSINESS_SUSPENDED" });
    }
    expect(await members()).toBe(before);
    expect((await authDb.query("SELECT name FROM organization WHERE id = $1", [organizationId])).rows[0].name).toBe("Salón Aurora");

    // ver sigue funcionando
    expect((await valeria.get(`/api/auth/organization/get-full-organization?organizationId=${organizationId}`)).statusCode).toBe(200);

    await setStatus("active");
    expect((await invite(valeria, organizationId)).statusCode).toBe(200);
    expect((await valeria.post("/api/auth/organization/update-member-role", { memberId: camila, role: "admin", organizationId })).statusCode).toBe(200);
  });

  it("aceptar una invitación: suspendido sí; dado de baja, no", async () => {
    const valeria = await as("valeria");
    const organizationId = await orgId();
    await invite(valeria, organizationId, "uno@ops-hh.test");
    await invite(valeria, organizationId, "dos@ops-hh.test");
    const idOf = async (email: string) => (await authDb.query("SELECT id FROM invitation WHERE email = $1", [email])).rows[0].id as string;

    const signUp = async (email: string) => {
      const b = browser(server.app);
      expect((await b.post("/api/auth/sign-up/email", { email, password: "una-clave-larga-123", name: "Nueva Persona" })).statusCode).toBe(200);
      return b;
    };
    const uno = await signUp("uno@ops-hh.test");
    const dos = await signUp("dos@ops-hh.test");

    await setStatus("closed");
    const closed = await dos.post("/api/auth/organization/accept-invitation", { invitationId: await idOf("dos@ops-hh.test") });
    expect(closed.statusCode).toBe(403);
    expect(closed.json()).toMatchObject({ code: "BUSINESS_CLOSED" });
    // dado de baja tampoco se invita
    expect((await invite(valeria, organizationId)).json()).toMatchObject({ code: "BUSINESS_CLOSED" });

    await setStatus("suspended");
    expect((await uno.post("/api/auth/organization/accept-invitation", { invitationId: await idOf("uno@ops-hh.test") })).statusCode).toBe(200);
  });
});
