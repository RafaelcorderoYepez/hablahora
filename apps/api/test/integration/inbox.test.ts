import type Anthropic from "@anthropic-ai/sdk";
import { ConversationDetail, HandoffCount } from "@hablahora/contracts";
import { AgentRunner, BookingService, MemoryEmailSender, WebChatProcessor } from "@hablahora/core";
import { AURORA, seedSalonAurora } from "@hablahora/db";
import { DateTime } from "luxon";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAuth } from "../../src/auth.js";
import { handoffNotifier } from "../../src/handoff-notify.js";
import { AURORA_USERS, DEV_PASSWORD, seedAuroraUsers } from "../../src/seed-users.js";
import { buildServer } from "../../src/server.js";
import { browser, ORIGIN } from "../../../../test/support/auth.js";
import { call, FAKE_MODEL, FakeLlm, say } from "../../../../test/support/fake-llm.js";
import { ADMIN_URL, APP_URL, AUTH_URL } from "../../../../test/support/global-setup.js";
import { chatClient } from "../../../../test/support/web-chat.js";

/** Bandeja de paso a humano: aviso a los administradores, responder, tomar y devolver al agente. */

let admin: pg.Pool;
let app: pg.Pool;
let authDb: pg.Pool;
let auth: ReturnType<typeof createAuth>["auth"];
let server: ReturnType<typeof buildServer>;
let chat: ReturnType<typeof chatClient>;
let now: Date;
const llm = new FakeLlm();
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
    email: new MemoryEmailSender(),
  });
  auth = created.auth;
  authDb = created.pool;
  const clock = () => now;
  const runner = new AgentRunner({
    db: app,
    bookings: new BookingService(app, clock),
    clock,
    model: FAKE_MODEL,
    llm: llm.client,
    onHandoff: handoffNotifier({ db: app, authDb, email, consoleURL: "http://consola.test/" }),
  });
  server = buildServer({
    auth: { auth, authDb, db: app, trustedOrigins: [ORIGIN], clock },
    webChat: new WebChatProcessor({ db: app, runner, clock, log: { info() {}, warn() {}, error() {} } }),
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
});

afterEach(() => expect(llm.stepErrors).toEqual([]));

const as = async (who: keyof typeof AURORA_USERS) => {
  const b = browser(server.app);
  expect((await b.signIn(AURORA_USERS[who].email, DEV_PASSWORD)).statusCode).toBe(200);
  const post = (url: string, payload: unknown = {}, origin: string | null = ORIGIN) =>
    server.app.inject({ method: "POST", url, payload: payload as any, headers: { cookie: b.cookie, ...(origin ? { origin } : {}) } });
  return { ...b, post };
};

const conversationId = async (sessionId: string) =>
  (await admin.query("SELECT id FROM conversations WHERE external_id = $1", [sessionId])).rows[0].id as string;

const transcript = async (sessionId: string) =>
  (await server.app.inject({ url: `/api/chat/${AURORA.slug}/sessions/${sessionId}/messages` })).json();

/** Conversación del chat web que el agente pasó al equipo. */
async function handedOff() {
  const sessionId = await chat.newSession();
  llm.script = [call("request_human", { reason: "Quiere un presupuesto para novias" }), say("Te comunico con el equipo.")];
  await chat.send(sessionId, "Necesito un presupuesto para mi boda");
  return { sessionId, id: await conversationId(sessionId) };
}

const userId = async (who: keyof typeof AURORA_USERS) =>
  (await authDb.query(`SELECT id FROM "user" WHERE email = $1`, [AURORA_USERS[who].email])).rows[0].id as string;

// ---------------------------------------------------------------------

describe("aviso a los administradores", () => {
  it("al pasar al equipo: correo a cada administrador en su idioma (no al staff) y el contador sube", async () => {
    await authDb.query(`UPDATE "user" SET locale = 'en' WHERE email = $1`, [AURORA_USERS.valeria.email]);
    const { id } = await handedOff();

    expect(email.sent.map((m) => m.to)).toEqual([AURORA_USERS.valeria.email]);
    const mail = email.sent[0];
    expect(mail.subject).toBe("Salón Aurora: a conversation needs the team");
    expect(mail.text).toContain("reason: Quiere un presupuesto para novias");
    expect(mail.text).toContain(`http://consola.test/conversaciones/${id}`);

    const camila = await as("camila");
    expect(HandoffCount.parse((await camila.get("/api/merchant/handoff/count")).json())).toEqual({ count: 1 });
  });
});

describe("el equipo atiende", () => {
  it("responde (el staff también), el cliente lo ve en su chat y el agente no habla mientras tanto", async () => {
    const { sessionId, id } = await handedOff();
    const camila = await as("camila");

    const res = await camila.post(`/api/merchant/conversations/${id}/reply`, { text: "Hola, soy Camila. ¿Para cuántas personas?" });
    expect(res.statusCode).toBe(200);
    const detail = ConversationDetail.parse(res.json());
    expect(detail.trace.messages.at(-1)).toMatchObject({ author: "staff", role: "assistant", authorUserId: await userId("camila") });
    expect(detail.conversation.handoff).toBe(true);

    expect((await transcript(sessionId)).messages.at(-1)).toMatchObject({ role: "staff", text: "Hola, soy Camila. ¿Para cuántas personas?" });

    // el cliente contesta: queda guardado, el agente no responde
    const calls = llm.calls.length;
    const answer = await chat.send(sessionId, "Somos 5");
    expect(answer.reply).toBe("");
    expect(llm.calls).toHaveLength(calls);
    const after = ConversationDetail.parse((await camila.get(`/api/merchant/conversations/${id}`)).json());
    expect(after.trace.messages.at(-1)).toMatchObject({ author: "customer" });
    // el costo del modelo es de la plataforma, no se muestra al negocio
    expect(after.trace.llmCalls[0]).not.toHaveProperty("costUsd");
  });

  it("al devolverla, el agente vuelve a responder y sabe qué dijo el equipo", async () => {
    const { sessionId, id } = await handedOff();
    const v = await as("valeria");
    await v.post(`/api/merchant/conversations/${id}/reply`, { text: "El presupuesto de novias es $300." });

    const released = ConversationDetail.parse((await v.post(`/api/merchant/conversations/${id}/release`)).json());
    expect(released.conversation.handoff).toBe(false);
    expect(HandoffCount.parse((await v.get("/api/merchant/handoff/count")).json())).toEqual({ count: 0 });
    expect((await transcript(sessionId)).handoff).toBe(false);

    llm.script = [
      (p) => {
        const assistantTexts = p.messages
          .filter((m) => m.role === "assistant")
          .flatMap((m) => (m.content as Anthropic.ContentBlockParam[]).filter((b) => b.type === "text").map((b) => (b as Anthropic.TextBlockParam).text));
        expect(assistantTexts).toContain("[Persona del equipo] El presupuesto de novias es $300.");
        const system = (p.system as Anthropic.TextBlockParam[]).map((b) => b.text).join("\n");
        expect(system).toContain('Los mensajes que empiezan con "[Persona del equipo]"');
        return say("¡Perfecto! ¿Quieres reservar la prueba de peinado?")(p);
      },
    ];
    const { reply } = await chat.send(sessionId, "Gracias");
    expect(reply).toBe("¡Perfecto! ¿Quieres reservar la prueba de peinado?");
    expect(llm.script).toEqual([]);
  });

  it("tomar una conversación que atiende el agente: deja de responder, sin correo a los administradores", async () => {
    const sessionId = await chat.newSession();
    llm.script = [say("¡Hola! ¿Qué necesitas?")];
    await chat.send(sessionId, "Hola");
    const id = await conversationId(sessionId);
    const camila = await as("camila");

    const taken = ConversationDetail.parse((await camila.post(`/api/merchant/conversations/${id}/take`)).json());
    expect(taken.conversation).toMatchObject({ handoff: true, handoffReason: `staff:${await userId("camila")}` });
    expect(email.sent).toEqual([]);
    const calls = llm.calls.length;
    await chat.send(sessionId, "¿Siguen ahí?");
    expect(llm.calls).toHaveLength(calls);
    // tomar dos veces no cambia nada
    expect((await camila.post(`/api/merchant/conversations/${id}/take`)).statusCode).toBe(200);
  });
});

describe("límites", () => {
  it("responder sin tomarla, en WhatsApp, sin origen, o una que no existe", async () => {
    const sessionId = await chat.newSession();
    llm.script = [say("Hola")];
    await chat.send(sessionId, "Hola");
    const id = await conversationId(sessionId);
    const v = await as("valeria");

    const notTaken = await v.post(`/api/merchant/conversations/${id}/reply`, { text: "Hola" });
    expect(notTaken.statusCode).toBe(409);
    expect(notTaken.json()).toMatchObject({ reason: "not_in_handoff" });

    const wa = await admin.query(
      `INSERT INTO conversations (tenant_id, location_id, channel, external_id, handoff) VALUES ($1, $2, 'whatsapp', '+13055550001', true) RETURNING id`,
      [AURORA.tenant, AURORA.location],
    );
    const whatsapp = await v.post(`/api/merchant/conversations/${wa.rows[0].id}/reply`, { text: "Hola" });
    expect(whatsapp.statusCode).toBe(422);
    expect(whatsapp.json()).toMatchObject({ reason: "channel_not_supported" });

    expect((await v.post(`/api/merchant/conversations/${id}/take`, {}, null)).statusCode).toBe(403);
    expect((await v.post(`/api/merchant/conversations/${id}/reply`, { text: "  " })).statusCode).toBe(400);
    expect((await v.post("/api/merchant/conversations/00000000-0000-4000-8000-000000000000/release")).statusCode).toBe(404);
    expect((await server.app.inject({ url: "/api/merchant/handoff/count" })).statusCode).toBe(401);
  });
});
