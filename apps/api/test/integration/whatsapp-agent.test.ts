import type Anthropic from "@anthropic-ai/sdk";
import { createHmac } from "node:crypto";
import { DateTime } from "luxon";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AgentRunner, BookingService, InboundProcessor, type WhatsAppSender } from "@hablahora/core";
import { buildServer } from "../../src/server.js";
import { waPayload } from "../../../../test/support/wa-payload.js";
import { clearBookings, IDS, seed } from "../../../../test/support/fixtures.js";
import { ADMIN_URL, APP_URL } from "../../../../test/support/global-setup.js";
import { contextOf } from "../../../../test/support/fake-llm.js";

const SECRET = "app-secret";
const NY = "America/New_York";
const TUE = "2026-10-13";

// ---------- LLM simulado: un guion de respuestas, una por llamada ----------

type Step = (p: Anthropic.MessageCreateParamsNonStreaming) => Anthropic.Message | Promise<Anthropic.Message>;
const message = (content: unknown[], stop: string) =>
  ({
    id: "msg_fake",
    type: "message",
    role: "assistant",
    model: "fake",
    content,
    stop_reason: stop,
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  }) as unknown as Anthropic.Message;
const say = (text: string): Step => () => message([{ type: "text", text }], "end_turn");
let toolSeq = 0;
const call = (name: string, input: Record<string, unknown> | ((p: any) => Record<string, unknown>)): Step => (p) =>
  message([{ type: "tool_use", id: `toolu_${++toolSeq}`, name, input: typeof input === "function" ? input(p) : input }], "tool_use");

/** Último tool_result que recibió el modelo, ya parseado. */
const lastToolResult = (p: Anthropic.MessageCreateParamsNonStreaming): any => {
  const last = p.messages[p.messages.length - 1];
  const block = (last.content as any[]).find((b) => b.type === "tool_result");
  return JSON.parse(block.content);
};
/** Busca en todo el historial un tool_result que contenga la clave. */
const findInHistory = (p: Anthropic.MessageCreateParamsNonStreaming, key: string): any => {
  for (const m of [...p.messages].reverse()) {
    for (const b of (Array.isArray(m.content) ? m.content : []) as any[]) {
      if (b.type === "tool_result" && b.content.includes(`"${key}"`)) return JSON.parse(b.content);
    }
  }
  return null;
};

// ---------- entorno ----------

let admin: pg.Pool;
let app: pg.Pool;
let now: Date;
let script: Step[];
let calls: Anthropic.MessageCreateParamsNonStreaming[];
let sent: { phoneNumberId: string; to: string; body: string }[];
let handoffs: string[];
let server: ReturnType<typeof buildServer>;

const sender: WhatsAppSender = {
  sendText: async (phoneNumberId, to, body) => void sent.push({ phoneNumberId, to, body }),
  markRead: async () => {},
};

let waSeq = 0;
async function receive(text: string, opts: { from?: string; phoneNumberId?: string; id?: string; type?: string } = {}) {
  const body = JSON.stringify(
    waPayload({
      phoneNumberId: opts.phoneNumberId ?? "wa-111",
      from: opts.from ?? "13055551234",
      id: opts.id ?? `wamid.${++waSeq}`,
      text,
      type: opts.type,
    }),
  );
  const res = await server.app.inject({
    method: "POST",
    url: "/webhook",
    payload: body,
    headers: {
      "content-type": "application/json",
      "x-hub-signature-256": "sha256=" + createHmac("sha256", SECRET).update(body).digest("hex"),
    },
  });
  expect(res.statusCode).toBe(200);
  return res;
}
const settle = () => server.background.idle();

beforeAll(async () => {
  admin = new pg.Pool({ connectionString: ADMIN_URL });
  app = new pg.Pool({ connectionString: APP_URL, max: 10 });
  await seed(admin);

  const clock = () => now;
  const bookings = new BookingService(app, clock);
  const runner = new AgentRunner({
    db: app,
    bookings,
    clock,
    model: "fake",
    llm: async (p) => {
      calls.push(structuredClone(p));
      const step = script.shift();
      if (!step) throw new Error("El guion del LLM se terminó");
      return step(p);
    },
    onHandoff: (_c, reason) => void handoffs.push(reason),
  });
  const processor = new InboundProcessor({ db: app, runner, sender, clock, log: { info() {}, warn() {}, error() {} } });
  server = buildServer({ whatsapp: { processor, appSecret: SECRET, verifyToken: "verify-me" } });
});

afterAll(async () => {
  await server.app.close();
  await app.end();
  await admin.end();
});

beforeEach(async () => {
  await clearBookings(admin);
  now = DateTime.fromISO("2026-10-12T12:00", { zone: NY }).toJSDate();
  script = [];
  calls = [];
  sent = [];
  handoffs = [];
});

// ---------- tests ----------

describe("webhook", () => {
  it("responde la verificación de Meta solo con el token correcto", async () => {
    const ok = await server.app.inject({
      url: "/webhook?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=12345",
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toBe("12345");
    const bad = await server.app.inject({ url: "/webhook?hub.mode=subscribe&hub.verify_token=no&hub.challenge=1" });
    expect(bad.statusCode).toBe(403);
  });

  it("rechaza mensajes sin firma válida", async () => {
    const res = await server.app.inject({
      method: "POST",
      url: "/webhook",
      payload: JSON.stringify(waPayload({ phoneNumberId: "wa-111", from: "1", id: "x", text: "hola" })),
      headers: { "content-type": "application/json", "x-hub-signature-256": "sha256=00" },
    });
    expect(res.statusCode).toBe(401);
    await settle();
    expect(calls).toHaveLength(0);
  });
});

describe("conversación completa por WhatsApp", () => {
  it("consulta → elige → aparta → confirma, y queda la reserva en la base", async () => {
    script = [
      call("check_availability", { service_id: IDS.cena, date: TUE, party_size: 2, preferred_time: "21:00" }),
      (p) => {
        const r = lastToolResult(p);
        expect(r.options.map((o: any) => o.time)).toContain("21:00");
        return say("¡Hola! Mañana a las 9:00 PM tengo mesa para 2. ¿A nombre de quién la aparto?")(p);
      },
      call("hold_slot", { service_id: IDS.cena, date: TUE, time: "21:00", party_size: 2, customer_name: "Rafael" }),
      (p) => {
        expect(lastToolResult(p)).toMatchObject({ held: true });
        return say("Te confirmo: mesa para 2, martes 13 a las 9:00 PM, a nombre de Rafael. ¿La confirmo?")(p);
      },
      // el booking_id sale del historial guardado en la base, no de memoria del proceso
      call("confirm_booking", (p) => ({ booking_id: findInHistory(p, "booking_id").booking_id })),
      (p) => {
        expect(lastToolResult(p)).toMatchObject({ confirmed: true });
        return say("¡Listo, Rafael! Te esperamos mañana a las 9:00 PM.")(p);
      },
    ];

    await receive("Hola! Mesa para 2 mañana a las 9 de la noche");
    await settle();
    await receive("A nombre de Rafael");
    await settle();
    await receive("Sí, confirmala");
    await settle();

    expect(script).toHaveLength(0);
    expect(sent.map((s) => s.body)).toEqual([
      "¡Hola! Mañana a las 9:00 PM tengo mesa para 2. ¿A nombre de quién la aparto?",
      "Te confirmo: mesa para 2, martes 13 a las 9:00 PM, a nombre de Rafael. ¿La confirmo?",
      "¡Listo, Rafael! Te esperamos mañana a las 9:00 PM.",
    ]);
    expect(sent.every((s) => s.to === "+13055551234" && s.phoneNumberId === "wa-111")).toBe(true);

    const { rows } = await admin.query(
      `SELECT b.status, b.source, c.name, c.phone_e164 FROM bookings b JOIN customers c ON c.id = b.customer_id`,
    );
    expect(rows).toEqual([{ status: "confirmed", source: "whatsapp", name: "Rafael", phone_e164: "+13055551234" }]);

    // el system prompt lleva los datos del negocio (fijo); la fecha local y el cliente van en el contexto
    const system = calls[0].system as Anthropic.TextBlockParam[];
    expect(system).toHaveLength(1);
    expect(system[0].text).toContain("Trattoria Demo");
    expect(system[0].text).toContain("Cocina italiana");
    // con un modelo que no acepta mensajes de sistema (como Haiku 5.5), el contexto va como texto
    // al final del mensaje del cliente, dentro de <contexto>
    expect(contextOf(calls[0])).toBe("");
    const firstUser = JSON.stringify(calls[0].messages[0].content);
    expect(firstUser).toContain("<contexto>");
    expect(firstUser).toContain("2026-10-12");
    expect(firstUser).toContain('\\"Rafa\\"');
    // la tercera vuelta recibe la conversación entera
    expect(calls[4].messages.length).toBeGreaterThan(6);

    // en WhatsApp el canal ya identifica al cliente: no hay herramienta de contacto
    expect(calls[0].tools!.map((t: any) => t.name)).not.toContain("save_customer_contact");
    expect(system[0].text).toContain("Solo di que apartaste, confirmaste, moviste o cancelaste");

    // el cliente quedó verificado por el canal y asociado a la conversación
    const conv = await admin.query(
      `SELECT cv.channel, cv.external_id, c.verified_via FROM conversations cv JOIN customers c ON c.id = cv.customer_id`,
    );
    expect(conv.rows).toEqual([{ channel: "whatsapp", external_id: "+13055551234", verified_via: "whatsapp" }]);
    const usage = await admin.query("SELECT channel, count(*)::int AS n FROM llm_usage GROUP BY channel");
    expect(usage.rows).toEqual([{ channel: "whatsapp", n: 6 }]);
  });

  it("cada negocio ve solo lo suyo", async () => {
    script = [
      call("list_services", {}),
      (p) => {
        expect(lastToolResult(p).services.map((s: any) => s.name)).toEqual(["Corte de pelo"]);
        return say("Hacemos cortes de pelo.")(p);
      },
    ];
    await receive("¿Qué servicios tienen?", { phoneNumberId: "wa-222" });
    await settle();
    expect(sent).toHaveLength(1);
  });
});

describe("robustez", () => {
  it("un reintento de Meta con el mismo mensaje se procesa una sola vez", async () => {
    script = [say("¡Hola!")];
    await receive("hola", { id: "wamid.dup" });
    await receive("hola", { id: "wamid.dup" });
    await settle();
    expect(calls).toHaveLength(1);
    expect(sent).toHaveLength(1);
  });

  it("dos mensajes seguidos se atienden en orden y el segundo ve la respuesta al primero", async () => {
    let active = 0;
    let maxActive = 0;
    const slow = (text: string): Step => async (p) => {
      maxActive = Math.max(maxActive, ++active);
      await new Promise((r) => setTimeout(r, 40));
      active--;
      return say(text)(p);
    };
    script = [slow("respuesta 1"), slow("respuesta 2")];
    await receive("mensaje 1");
    await receive("mensaje 2");
    await settle();
    expect(maxActive).toBe(1);
    expect(sent.map((s) => s.body)).toEqual(["respuesta 1", "respuesta 2"]);
    const secondCall = JSON.stringify(calls[1].messages);
    expect(secondCall).toContain("respuesta 1");
  });

  it("audios y fotos reciben un aviso sin pasar por el modelo", async () => {
    await receive("", { type: "audio" });
    await settle();
    expect(calls).toHaveLength(0);
    expect(sent[0].body).toContain("solo puedo leer mensajes de texto");
  });

  it("un número que no pertenece a ningún negocio se ignora", async () => {
    await receive("hola", { phoneNumberId: "desconocido" });
    await settle();
    expect(calls).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it("si el modelo falla, el cliente recibe un mensaje en lugar de silencio", async () => {
    script = [() => { throw new Error("API caída"); }];
    await receive("hola");
    await settle();
    expect(sent).toHaveLength(1);
    // no promete pasar con una persona: no lo hizo, y una caída pasajera no lo amerita
    expect(sent[0].body).toContain("Tuve un problema para responderte");
    expect(handoffs).toEqual([]);
    const { rows } = await admin.query("SELECT handoff FROM conversations");
    expect(rows).toEqual([{ handoff: false }]);
  });

  it("si el modelo entra en bucle de tools, se corta y pasa a una persona", async () => {
    script = Array.from({ length: 8 }, () => call("list_services", {}));
    await receive("hola");
    await settle();
    expect(handoffs).toEqual(["max_tool_rounds"]);
    expect(sent[0].body).toContain("alguien del equipo");
  });
});

describe("paso a una persona", () => {
  it("el agente pide ayuda humana y después deja de responder", async () => {
    script = [
      call("request_human", { reason: "Quiere reservar el salón privado para 30 personas" }),
      say("Te comunico con alguien del equipo, te escribirán por aquí."),
    ];
    await receive("Quiero el salón privado para 30 personas");
    await settle();
    expect(handoffs).toEqual(["Quiere reservar el salón privado para 30 personas"]);
    expect(sent).toHaveLength(1);

    await receive("¿Hola? ¿Alguien?");
    await settle();
    expect(calls).toHaveLength(2); // el modelo no se volvió a llamar
    expect(sent).toHaveLength(1); // y el cliente no recibió respuesta automática

    const { rows } = await admin.query(
      `SELECT c.handoff, count(m.*)::int AS messages
         FROM conversations c JOIN conversation_messages m ON m.conversation_id = c.id
        GROUP BY c.id`,
    );
    expect(rows[0].handoff).toBe(true);
    expect(rows[0].messages).toBe(6); // con el contexto del turno; el último mensaje quedó guardado para el humano
  });
});
