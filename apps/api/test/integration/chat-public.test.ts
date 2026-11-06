import type Anthropic from "@anthropic-ai/sdk";
import { ChatTranscript, PublicChatInfo } from "@hablahora/contracts";
import { AgentRunner, BookingService, EmailCodeService, MemoryEmailSender, WebChatProcessor } from "@hablahora/core";
import { AURORA, seedSalonAurora } from "@hablahora/db";
import { DateTime } from "luxon";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAuth } from "../../src/auth.js";
import { AURORA_USERS, DEV_PASSWORD, seedAuroraUsers } from "../../src/seed-users.js";
import { buildServer } from "../../src/server.js";
import { browser, ORIGIN } from "../../../../test/support/auth.js";
import { call, contextOf, fail, FAKE_MODEL, FakeLlm, findInHistory, lastToolResult, say } from "../../../../test/support/fake-llm.js";
import { ADMIN_URL, APP_URL, AUTH_URL } from "../../../../test/support/global-setup.js";
import { parseSse } from "../../../../test/support/web-chat.js";

/** Lo que usa la página del chat: datos del negocio, sesiones con idioma y transcripción. */

const WED = "2026-10-14";
const BASE = `/api/chat/${AURORA.slug}`;

let admin: pg.Pool;
let app: pg.Pool;
let authDb: pg.Pool;
let auth: ReturnType<typeof createAuth>["auth"];
let now: Date;
let server: ReturnType<typeof buildServer>;
const llm = new FakeLlm();
const emails = new MemoryEmailSender();

beforeAll(async () => {
  admin = new pg.Pool({ connectionString: ADMIN_URL });
  app = new pg.Pool({ connectionString: APP_URL, max: 10 });
  const created = createAuth({
    databaseUrl: AUTH_URL,
    baseURL: ORIGIN,
    secret: "secreto-de-tests-0123456789-0123456789",
    trustedOrigins: [ORIGIN],
    consoleURL: ORIGIN,
    email: emails,
  });
  auth = created.auth;
  authDb = created.pool;
  const clock = () => now;
  const runner = new AgentRunner({
    db: app,
    bookings: new BookingService(app, clock),
    emailCodes: new EmailCodeService({ db: app, email: emails, clock }),
    clock,
    model: FAKE_MODEL,
    llm: llm.client,
  });
  const quiet = { info() {}, warn() {}, error() {} };
  server = buildServer({
    webChat: new WebChatProcessor({ db: app, runner, clock, log: quiet }),
    auth: { auth, authDb, db: app, trustedOrigins: [ORIGIN], clock },
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
  now = DateTime.fromISO("2026-10-12T12:00", { zone: AURORA.timezone }).toJSDate();
  llm.reset();
  emails.sent = [];
});

afterEach(() => {
  expect(llm.stepErrors).toEqual([]);
  expect(llm.script).toEqual([]);
});

async function newSession(locale?: "es" | "en") {
  const res = await server.app.inject({ method: "POST", url: `${BASE}/sessions`, payload: locale ? { locale } : {} });
  expect(res.statusCode).toBe(201);
  return res.json() as { sessionId: string; locale: string };
}

async function send(sessionId: string, text: string, locale?: "es" | "en") {
  const res = await server.app.inject({
    method: "POST",
    url: `${BASE}/sessions/${sessionId}/messages`,
    payload: locale ? { text, locale } : { text },
  });
  const events = parseSse(res.body);
  return { events, reply: events.filter((e) => e.event === "text").map((e) => e.data.text).join("") };
}

describe("datos públicos del negocio", () => {
  it("nombre, idioma, color y bienvenida, sin ids internos", async () => {
    const res = await server.app.inject({ url: BASE });
    expect(res.statusCode).toBe(200);
    const info = PublicChatInfo.parse(res.json());
    expect(info).toMatchObject({ name: "Salón Aurora", locale: "es", accent: "#B4416A", appearance: "auto" });
    expect(info.welcome.en).toContain("Salón Aurora's assistant");
    expect(JSON.stringify(res.json())).not.toContain(AURORA.tenant);
    expect((await server.app.inject({ url: "/api/chat/no-existe" })).statusCode).toBe(404);
  });

  it("el negocio cambia su estilo desde la consola; un color propio muy claro se rechaza", async () => {
    const valeria = browser(server.app);
    await seedAuroraUsers({ auth, authDb, adminDb: admin, tenantId: AURORA.tenant, slug: AURORA.slug });
    expect((await valeria.signIn(AURORA_USERS.valeria.email, DEV_PASSWORD)).statusCode).toBe(200);
    const patch = (chatSettings: unknown) =>
      server.app.inject({
        method: "PATCH",
        url: "/api/merchant/business",
        headers: { cookie: valeria.cookie, origin: ORIGIN },
        payload: { chatSettings },
      });

    const light = await patch({ palette: "custom", accent: "#F5E0A0", appearance: "light" });
    expect(light.statusCode).toBe(400);
    expect(light.json().issues).toEqual([expect.objectContaining({ path: "chatSettings.accent" })]);
    expect((await patch({ palette: "custom", appearance: "light" })).statusCode).toBe(400);

    expect((await patch({ palette: "custom", accent: "#1F5F7A", appearance: "dark" })).statusCode).toBe(200);
    expect((await server.app.inject({ url: BASE })).json()).toMatchObject({ accent: "#1F5F7A", appearance: "dark" });

    expect((await patch({ palette: "rosa", tint: true, texture: "dots" })).statusCode).toBe(200);
    expect((await server.app.inject({ url: BASE })).json()).toMatchObject({ tint: true, texture: "dots" });
    expect((await patch({ palette: "rosa", texture: "madera" })).statusCode).toBe(400);

    await patch({ palette: "salvia" });
    expect((await server.app.inject({ url: BASE })).json()).toMatchObject({
      accent: "#3F7056",
      appearance: "auto",
      tint: false,
      texture: "none",
      welcome: { es: null, en: null },
    });
  });
});

describe("idioma de la conversación", () => {
  it("la sesión toma el idioma pedido o el del negocio", async () => {
    expect((await newSession("en")).locale).toBe("en");
    expect((await newSession()).locale).toBe("es");
    const bad = await server.app.inject({ method: "POST", url: `${BASE}/sessions`, payload: { locale: "fr" } });
    expect(bad.statusCode).toBe(400);
  });

  it("los avisos fijos salen en el idioma de la conversación", async () => {
    const en = await newSession("en");
    llm.script = [fail()];
    expect((await send(en.sessionId, "Hi")).reply).toBe("I had trouble replying just now. Could you send that again in a moment?");

    const es = await newSession("es");
    llm.script = [fail()];
    expect((await send(es.sessionId, "Hola")).reply).toBe("Tuve un problema para responderte. ¿Me lo escribes de nuevo en un momento?");
  });

  it("cambiar el idioma en la página lo cambia en la conversación (avisos y correo del código)", async () => {
    const { sessionId } = await newSession("es");
    llm.script = [call("request_email_code", { email: "rafa@example.com" }), say("I sent you a code.")];
    await send(sessionId, "I want to cancel my booking, rafa@example.com", "en");

    const conv = await admin.query("SELECT locale FROM conversations WHERE external_id = $1", [sessionId]);
    expect(conv.rows[0].locale).toBe("en");
    expect(emails.lastTo("rafa@example.com")?.subject).toMatch(/^Your Salón Aurora code: \d{6}$/);
    // el agente sabe qué idioma usar si el mensaje no lo deja claro
    expect(contextOf(llm.calls[0])).toContain("usa inglés");

    llm.script = [fail()];
    expect((await send(sessionId, "?")).reply).toContain("I had trouble replying");
  });
});

describe("transcripción para retomar la conversación", () => {
  it("devuelve solo los textos del cliente y del agente, y si pasó a una persona", async () => {
    const { sessionId } = await newSession();
    llm.script = [
      call("save_customer_contact", { name: "Rafael", phone: "912345678", email: "rafa@example.com" }),
      call("hold_slot", { service_id: AURORA.services.corteMujer, date: WED, time: "11:00", party_size: 1 }),
      say("Te aparté el miércoles a las 11:00. ¿Lo confirmo?"),
    ];
    await send(sessionId, "Corte el miércoles a las 11, Rafael, 912345678, rafa@example.com");
    llm.script = [call("request_human", { reason: "Quiere un precio especial" }), say("Te comunico con el equipo.")];
    await send(sessionId, "¿Me hacen descuento?");

    const res = await server.app.inject({ url: `${BASE}/sessions/${sessionId}/messages` });
    const transcript = ChatTranscript.parse(res.json());
    expect(transcript.handoff).toBe(true);
    expect(transcript.locale).toBe("es");
    expect(transcript.messages.map((m) => [m.role, m.text])).toEqual([
      ["customer", "Corte el miércoles a las 11, Rafael, 912345678, rafa@example.com"],
      ["agent", "Te aparté el miércoles a las 11:00. ¿Lo confirmo?"],
      ["customer", "¿Me hacen descuento?"],
      ["agent", "Te comunico con el equipo."],
    ]);
    expect(JSON.stringify(transcript)).not.toContain("hold_slot");

    expect((await server.app.inject({ url: `${BASE}/sessions/AAAAAAAAAAAAAAAAAAAAAA/messages` })).statusCode).toBe(404);
  });
});

describe("reserva en inglés", () => {
  it("mismas herramientas y misma agenda que en español", async () => {
    const { sessionId } = await newSession("en");
    llm.script = [
      call("list_services", {}),
      call("check_availability", (p) => ({
        service_id: findInHistory(p, "services").services.find((s: any) => s.name === "Corte de mujer").service_id,
        date: WED,
        party_size: 1,
        preferred_time: "11:00",
      })),
      say("I have Wednesday at 11:00 AM with Valeria. May I have your name, phone and email?"),
    ];
    const first = await send(sessionId, "Hi! Can I book a women's haircut on Wednesday at 11?");
    expect(first.events.map((e) => e.event)).toEqual(["tool", "tool", "text", "text", "done"]);

    llm.script = [
      call("save_customer_contact", { name: "Rachel", phone: "9 5555 7788", email: "rachel@example.com" }),
      call("hold_slot", { service_id: AURORA.services.corteMujer, date: WED, time: "11:00", party_size: 1 }),
      (p) => {
        expect(lastToolResult(p)).toMatchObject({ held: true });
        return say("I've held Wednesday at 11:00 AM with Valeria. Shall I confirm it?")(p);
      },
    ];
    await send(sessionId, "Rachel, 9 5555 7788, rachel@example.com");
    llm.script = [
      call("confirm_booking", (p) => ({ booking_id: findInHistory(p, "booking_id").booking_id })),
      (p) => {
        expect(lastToolResult(p)).toMatchObject({ confirmed: true });
        return say("You're all set! See you Wednesday at 11:00 AM.")(p);
      },
    ];
    await send(sessionId, "Yes please");

    const tools = await admin.query(
      `SELECT tc.name FROM tool_calls tc JOIN conversations c ON c.id = tc.conversation_id WHERE c.external_id = $1 ORDER BY tc.id`,
      [sessionId],
    );
    expect(tools.rows.map((r) => r.name)).toEqual([
      "list_services",
      "check_availability",
      "save_customer_contact",
      "hold_slot",
      "confirm_booking",
    ]);
    const { rows } = await admin.query(
      `SELECT b.status, to_char(b.starts_at AT TIME ZONE $2, 'YYYY-MM-DD HH24:MI') AS starts, c.name, c.phone_e164
         FROM bookings b JOIN customers c ON c.id = b.customer_id WHERE b.tenant_id = $1`,
      [AURORA.tenant, AURORA.timezone],
    );
    expect(rows).toEqual([{ status: "confirmed", starts: `${WED} 11:00`, name: "Rachel", phone_e164: "+56955557788" }]);
  });
});
