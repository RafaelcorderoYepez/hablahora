import type Anthropic from "@anthropic-ai/sdk";
import { DateTime } from "luxon";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AgentRunner, BookingService, getConversationTrace, WebChatProcessor, withTenant } from "@hablahora/core";
import { buildServer } from "../../src/server.js";
import { call, contextOf, fail, FAKE_MODEL as MODEL, FakeLlm, findInHistory, lastToolResult, say, type Step } from "../../../../test/support/fake-llm.js";
import { clearBookings, IDS, seed } from "../../../../test/support/fixtures.js";
import { ADMIN_URL, APP_URL } from "../../../../test/support/global-setup.js";
import { chatClient } from "../../../../test/support/web-chat.js";

const NY = "America/New_York";
const TUE = "2026-10-13";
const SLUG = "salon-demo"; // tenant B: peluquería, confirma a mano

let admin: pg.Pool;
let app: pg.Pool;
let now: Date;
let server: ReturnType<typeof buildServer>;
let chat: ReturnType<typeof chatClient>;
const llm = new FakeLlm();

beforeAll(async () => {
  admin = new pg.Pool({ connectionString: ADMIN_URL });
  app = new pg.Pool({ connectionString: APP_URL, max: 10 });
  await seed(admin);

  const clock = () => now;
  const bookings = new BookingService(app, clock);
  const runner = new AgentRunner({ db: app, bookings, clock, model: MODEL, llm: llm.client });
  const quiet = { info() {}, warn() {}, error() {} };
  server = buildServer({ webChat: new WebChatProcessor({ db: app, runner, clock, log: quiet }) });
  chat = chatClient(server.app, SLUG);
});

afterAll(async () => {
  await server.app.close();
  await app.end();
  await admin.end();
});

beforeEach(async () => {
  await clearBookings(admin);
  now = DateTime.fromISO("2026-10-12T12:00", { zone: NY }).toJSDate();
  llm.reset();
});

afterEach(() => {
  expect(llm.stepErrors).toEqual([]);
});

const newSession = (slug?: string) => chat.newSession(slug);
const send = (sessionId: string, text: string, slug?: string) => chat.send(sessionId, text, slug);

const conversationOf = async (sessionId: string) =>
  (await admin.query("SELECT * FROM conversations WHERE channel = 'web' AND external_id = $1", [sessionId])).rows[0];

/** Guion de una reserva completa en la web: contacto → apartar → confirmar. */
function bookingScript(contact: Record<string, string>, time = "10:00"): Step[] {
  return [
    call("save_customer_contact", contact),
    (p) => {
      expect(lastToolResult(p)).toMatchObject({ saved: true });
      return call("hold_slot", { service_id: IDS.corte, date: TUE, time, party_size: 1 })(p);
    },
    (p) => {
      expect(lastToolResult(p)).toMatchObject({ held: true });
      return say("Te aparté el corte. ¿Lo confirmo?")(p);
    },
    call("confirm_booking", (p) => ({ booking_id: findInHistory(p, "booking_id").booking_id })),
    (p) => {
      expect(lastToolResult(p)).toMatchObject({ status: "pending" });
      return say("Listo, quedó pedido. El salón te confirma.")(p);
    },
  ];
}

// ---------- tests ----------

describe("sesiones del chat web", () => {
  it("crea una sesión anónima por slug", async () => {
    const sessionId = await newSession();
    expect(sessionId).toMatch(/^[A-Za-z0-9_-]{22}$/);
    const conv = await conversationOf(sessionId);
    expect(conv).toMatchObject({ tenant_id: IDS.tenantB, location_id: IDS.locB, channel: "web", customer_id: null });
  });

  it("un slug o una sesión que no existen dan 404", async () => {
    const res = await server.app.inject({ method: "POST", url: "/api/chat/no-existe/sessions" });
    expect(res.statusCode).toBe(404);
    const sessionId = await newSession();
    expect((await send("AAAAAAAAAAAAAAAAAAAAAA", "hola")).res.statusCode).toBe(404);
    // la sesión de un negocio no sirve en el chat de otro
    expect((await send(sessionId, "hola", "trattoria-demo")).res.statusCode).toBe(404);
    expect(llm.calls).toHaveLength(0);
  });

  it("rechaza mensajes vacíos o demasiado largos", async () => {
    const sessionId = await newSession();
    expect((await send(sessionId, "   ")).res.statusCode).toBe(400);
    expect((await send(sessionId, "a".repeat(2001))).res.statusCode).toBe(400);
    expect(llm.calls).toHaveLength(0);
  });

  it("WhatsApp está apagado si no se configura", async () => {
    const res = await server.app.inject({ url: "/webhook?hub.mode=subscribe&hub.verify_token=x&hub.challenge=1" });
    expect(res.statusCode).toBe(404);
  });
});

describe("respuesta por SSE", () => {
  it("entrega el texto en fragmentos, avisa las herramientas y termina con done", async () => {
    const sessionId = await newSession();
    llm.script = [
      call("list_services", {}),
      say("Hacemos cortes de pelo. ¿Para qué día lo quieres?"),
    ];
    const { res, events, reply } = await send(sessionId, "¿Qué servicios tienen?");

    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(events.map((e) => e.event)).toEqual(["tool", "text", "text", "done"]);
    expect(events[0].data).toEqual({ name: "list_services" }); // sin entradas ni resultados
    expect(reply).toBe("Hacemos cortes de pelo. ¿Para qué día lo quieres?");

    // el historial queda guardado igual que en WhatsApp
    const conv = await conversationOf(sessionId);
    const { rows } = await admin.query(
      "SELECT role, author FROM conversation_messages WHERE conversation_id = $1 ORDER BY id",
      [conv.id],
    );
    // el contexto del turno queda guardado antes de la primera respuesta del agente
    expect(rows.map((r) => `${r.role}:${r.author}`)).toEqual([
      "user:customer",
      "system:system",
      "assistant:agent",
      "user:tool",
      "assistant:agent",
    ]);
    expect(conv.last_customer_message_at).not.toBeNull();
  });

  it("si el modelo falla, el cliente recibe un aviso y el error queda registrado", async () => {
    const sessionId = await newSession();
    llm.script = [fail()];
    const { events, reply } = await send(sessionId, "Hola");
    expect(reply).toContain("Tuve un problema para responderte");
    expect(events.at(-1)!.event).toBe("done");
    const { rows } = await admin.query("SELECT error, input_tokens, cost_usd FROM llm_usage");
    expect(rows).toEqual([{ error: "Error: API caída", input_tokens: 0, cost_usd: null }]);
  });

  it("al pasar a una persona avisa con handoff y después el agente calla", async () => {
    const sessionId = await newSession();
    llm.script = [call("request_human", { reason: "Quiere hablar con alguien" }), say("Te comunico con el equipo.")];
    const first = await send(sessionId, "Quiero hablar con una persona");
    expect(first.events.map((e) => e.event)).toEqual(["tool", "handoff", "text", "text", "done"]);

    const second = await send(sessionId, "¿Hola?");
    expect(second.events.map((e) => e.event)).toEqual(["done"]);
    expect(llm.calls).toHaveLength(2);
  });
});

describe("reservas desde el chat web", () => {
  it("sin contacto no se puede apartar; con contacto se reserva a nombre del cliente", async () => {
    const sessionId = await newSession();
    llm.script = [
      call("hold_slot", { service_id: IDS.corte, date: TUE, time: "10:00", party_size: 1 }),
      (p) => {
        expect(lastToolResult(p)).toMatchObject({ held: false, reason: "customer_contact_required" });
        return say("Para apartarlo necesito tu nombre y un teléfono o email.")(p);
      },
    ];
    await send(sessionId, "Quiero un corte mañana a las 10");
    // las instrucciones piden el contacto y la herramienta está disponible
    expect(llm.calls[0].tools!.map((t: any) => t.name)).toContain("save_customer_contact");
    expect(contextOf(llm.calls[0])).toContain("Aún no tienes los datos de contacto");

    llm.script = bookingScript({ name: "Rafael", phone: "(305) 555-1234", email: "Rafa@Example.com" });
    await send(sessionId, "Rafael, 305 555 1234, rafa@example.com");
    await send(sessionId, "Sí");
    expect(llm.script).toHaveLength(0);
    // tras guardar el contacto, la siguiente vuelta ya lo sabe
    expect(contextOf(llm.calls[3])).toContain("ya dejó sus datos");

    const { rows } = await admin.query(
      `SELECT b.status, b.source, c.name, c.phone_e164, c.email, c.verified_via
         FROM bookings b JOIN customers c ON c.id = b.customer_id`,
    );
    // negocio de EE.UU.: el teléfono sin prefijo se completó con +1, y el agente sabe que cobra en dólares
    expect(rows).toEqual([
      { status: "pending", source: "web", name: "Rafael", phone_e164: "+13055551234", email: "rafa@example.com", verified_via: null },
    ]);
    const system = (llm.calls[0].system as Anthropic.TextBlockParam[]).map((b) => b.text).join("\n");
    expect(system).toContain("El negocio está en Estados Unidos.");
    expect(system).toContain("en dólares");
    const conv = await conversationOf(sessionId);
    expect(conv.customer_id).not.toBeNull();
  });

  it("un contacto inválido no se guarda", async () => {
    const sessionId = await newSession();
    llm.script = [
      call("save_customer_contact", { name: "Ana", phone: "123" }),
      (p) => {
        expect(lastToolResult(p)).toEqual({ saved: false, reason: "invalid_phone" });
        return call("save_customer_contact", { name: "Ana" })(p);
      },
      (p) => {
        expect(lastToolResult(p)).toEqual({ saved: false, reason: "contact_required" });
        return say("¿Me das un teléfono o email válido?")(p);
      },
    ];
    await send(sessionId, "Soy Ana, mi teléfono es 123");
    expect(llm.script).toHaveLength(0);
    expect((await admin.query("SELECT count(*)::int AS n FROM customers")).rows[0].n).toBe(0);
  });

  it("dos sesiones con el mismo teléfono no ven ni tocan las reservas de la otra", async () => {
    const owner = await newSession();
    llm.script = bookingScript({ name: "Rafael", phone: "3055551234", email: "rafa@example.com" });
    await send(owner, "Corte mañana a las 10, soy Rafael, 3055551234, rafa@example.com");
    await send(owner, "Sí");
    const bookingId = (await admin.query("SELECT id FROM bookings")).rows[0].id;

    const intruder = await newSession();
    llm.script = [
      call("save_customer_contact", { name: "Rafael", phone: "3055551234" }),
      call("list_my_bookings", {}),
      (p) => {
        expect(lastToolResult(p)).toEqual({ bookings: [] });
        return call("cancel_booking", { booking_id: bookingId })(p);
      },
      (p) => {
        expect(lastToolResult(p)).toEqual({ cancelled: false, reason: "not_found" });
        return say("No encuentro reservas a tu nombre en esta conversación.")(p);
      },
    ];
    await send(intruder, "Soy Rafael, 3055551234, cancela mi reserva");
    expect(llm.script).toHaveLength(0);

    const { rows } = await admin.query("SELECT status FROM bookings WHERE id = $1", [bookingId]);
    expect(rows[0].status).toBe("pending");
    // dos clientes distintos sin verificar, no uno fusionado
    expect((await admin.query("SELECT count(*)::int AS n FROM customers")).rows[0].n).toBe(2);
  });

  it("en su propia conversación el cliente ve y cancela lo que reservó", async () => {
    const sessionId = await newSession();
    llm.script = bookingScript({ name: "Rafael", phone: "3055551234", email: "rafa@example.com" });
    await send(sessionId, "Corte mañana a las 10, soy Rafael, 3055551234, rafa@example.com");
    await send(sessionId, "Sí");

    llm.script = [
      call("list_my_bookings", {}),
      (p) => call("cancel_booking", { booking_id: lastToolResult(p).bookings[0].booking_id })(p),
      (p) => {
        expect(lastToolResult(p)).toMatchObject({ cancelled: true });
        return say("Cancelada.")(p);
      },
    ];
    await send(sessionId, "Cancélala, por favor");
    expect(llm.script).toHaveLength(0);
    expect((await admin.query("SELECT status FROM bookings")).rows[0].status).toBe("cancelled");
  });
});

describe("uso del modelo y traza", () => {
  it("registra cada llamada con tokens, costo y turno, y cada herramienta con su duración", async () => {
    const sessionId = await newSession();
    llm.script = [
      call("check_availability", { service_id: IDS.corte, date: TUE, party_size: 1, preferred_time: "10:00" }),
      call("check_availability", { service_id: "no-existe", date: TUE, party_size: 1 }),
      say("Mañana tengo a las 10:00."),
    ];
    await send(sessionId, "¿Tienen hora mañana?");
    llm.script = [say("De nada.")];
    await send(sessionId, "Gracias");

    const conv = await conversationOf(sessionId);
    const trace = await withTenant(app, IDS.tenantB, (tx) => getConversationTrace(tx, conv.id));

    expect(trace.messages.map((m) => m.author)).toEqual([
      "customer",
      "system",
      "agent",
      "tool",
      "agent",
      "tool",
      "agent",
      "customer",
      "system",
      "agent",
    ]);
    expect(trace.llmCalls).toHaveLength(4);
    // las tres llamadas del primer mensaje comparten turno; la del segundo, otro
    const turns = trace.llmCalls.map((c) => c.turnId);
    expect(new Set(turns.slice(0, 3)).size).toBe(1);
    expect(turns[3]).not.toBe(turns[0]);

    // Sonnet 5.5: 1000 × $2 + 50 × $10 + 2000 × $0.20 por millón
    expect(trace.llmCalls[0]).toMatchObject({
      model: MODEL,
      inputTokens: 1000,
      outputTokens: 50,
      cacheReadInputTokens: 2000,
      costUsd: 0.0029,
      stopReason: "tool_use",
      error: null,
    });
    expect(trace.llmCalls[2].stopReason).toBe("end_turn");

    const [ok] = trace.llmCalls[0].toolCalls;
    expect(ok).toMatchObject({ name: "check_availability", isError: false });
    expect(ok.input).toMatchObject({ preferred_time: "10:00" });
    expect((ok.result as any).options.length).toBeGreaterThan(0);
    expect(ok.durationMs).toBeGreaterThanOrEqual(0);

    const [bad] = trace.llmCalls[1].toolCalls;
    expect(bad).toMatchObject({ name: "check_availability", isError: true, result: { error: "service_not_found" } });
    expect(trace.llmCalls[2].toolCalls).toEqual([]);
  });

  it("el uso y la traza de un negocio no los ve otro", async () => {
    const sessionId = await newSession();
    llm.script = [call("list_services", {}), say("Cortes.")];
    await send(sessionId, "Hola");

    const count = (tenant: string) =>
      withTenant(app, tenant, async (tx) => {
        const u = await tx.query("SELECT count(*)::int AS n FROM llm_usage");
        const t = await tx.query("SELECT count(*)::int AS n FROM tool_calls");
        return [u.rows[0].n, t.rows[0].n];
      });
    expect(await count(IDS.tenantB)).toEqual([2, 1]);
    expect(await count(IDS.tenantA)).toEqual([0, 0]);
  });

  it("las instrucciones incluyen la regla de no afirmar acciones", async () => {
    const sessionId = await newSession();
    llm.script = [say("Hola, ¿en qué te ayudo?")];
    await send(sessionId, "Hola");
    const fixed = (llm.calls[0].system as Anthropic.TextBlockParam[])[0].text;
    expect(fixed).toContain("del chat web");
    expect(fixed).toContain("Solo di que apartaste, confirmaste, moviste o cancelaste");
    expect(fixed).not.toContain("WhatsApp");
  });
});

describe("límites del chat público", () => {
  // servidor aparte con límites bajos, para no depender del orden de los demás tests
  let limited: ReturnType<typeof buildServer>;
  let client: ReturnType<typeof chatClient>;

  beforeAll(() => {
    const clock = () => now;
    const runner = new AgentRunner({ db: app, bookings: new BookingService(app, clock), clock, model: MODEL, llm: llm.client });
    const quiet = { info() {}, warn() {}, error() {} };
    limited = buildServer({
      webChat: new WebChatProcessor({ db: app, runner, clock, log: quiet, maxMessagesPerSession: 2 }),
      chatSessionsPerIpPerHour: 2,
    });
    client = chatClient(limited.app, SLUG);
  });

  afterAll(() => limited.app.close());

  it("después del máximo de mensajes por sesión responde 429 sin llamar al modelo", async () => {
    const sessionId = await client.newSession();
    llm.script = [say("Hola."), say("¿En qué te ayudo?")];
    expect((await client.send(sessionId, "Hola")).res.statusCode).toBe(200);
    expect((await client.send(sessionId, "¿Hay hora mañana?")).res.statusCode).toBe(200);

    const third = await client.send(sessionId, "¿Y pasado?");
    expect(third.res.statusCode).toBe(429);
    expect(third.res.json()).toMatchObject({ error: "session_limit" });
    expect(llm.calls).toHaveLength(2);
  });

  it("limita las sesiones nuevas por IP", async () => {
    const create = () => limited.app.inject({ method: "POST", url: `/api/chat/${SLUG}/sessions`, remoteAddress: "203.0.113.7" });
    expect((await create()).statusCode).toBe(201);
    expect((await create()).statusCode).toBe(201);
    const third = await create();
    expect(third.statusCode).toBe(429);
    expect(third.json()).toMatchObject({ error: "rate_limited" });
    // otra IP no se ve afectada
    const other = await limited.app.inject({ method: "POST", url: `/api/chat/${SLUG}/sessions`, remoteAddress: "203.0.113.8" });
    expect(other.statusCode).toBe(201);
  });
});
