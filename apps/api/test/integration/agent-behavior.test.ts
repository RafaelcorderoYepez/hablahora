import type Anthropic from "@anthropic-ai/sdk";
import { AURORA, seedSalonAurora } from "@hablahora/db";
import { AgentRunner, BookingService, WebChatProcessor, type ConversationContext } from "@hablahora/core";
import { DateTime } from "luxon";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../../src/server.js";
import {
  call,
  FAKE_MODEL,
  FakeLlm,
  findInHistory,
  lastToolResult,
  say,
  type Step,
} from "../../../../test/support/fake-llm.js";
import { ADMIN_URL, APP_URL } from "../../../../test/support/global-setup.js";
import { chatClient } from "../../../../test/support/web-chat.js";

/**
 * Casos de la demo, contra el seed del Salón Aurora y por el chat web.
 * El modelo es un guion: estos tests no miden el criterio del modelo real,
 * sino que, ante cada decisión del modelo, el motor y el runner hacen lo
 * correcto y la agenda queda como debe (y que el motor frena lo que no corresponde).
 */

const TZ = AURORA.timezone;
const WED = "2026-10-14";
const THU = "2026-10-15";
const SUN = "2026-10-18";

let admin: pg.Pool;
let app: pg.Pool;
let now: Date;
let server: ReturnType<typeof buildServer>;
let chat: ReturnType<typeof chatClient>;
let bookings: BookingService;
const llm = new FakeLlm();

beforeAll(async () => {
  admin = new pg.Pool({ connectionString: ADMIN_URL });
  app = new pg.Pool({ connectionString: APP_URL, max: 10 });
  const clock = () => now;
  bookings = new BookingService(app, clock);
  const runner = new AgentRunner({ db: app, bookings, clock, model: FAKE_MODEL, llm: llm.client });
  const quiet = { info() {}, warn() {}, error() {} };
  server = buildServer({ webChat: new WebChatProcessor({ db: app, runner, clock, log: quiet }) });
  chat = chatClient(server.app, AURORA.slug);
});

afterAll(async () => {
  await server.app.close();
  await app.end();
  await admin.end();
});

beforeEach(async () => {
  await seedSalonAurora(admin); // el salón limpio en cada caso
  // lunes: el salón cierra, pero el cliente escribe igual
  now = DateTime.fromISO("2026-10-12T12:00", { zone: TZ }).toJSDate();
  llm.reset();
});

afterEach(() => {
  expect(llm.stepErrors).toEqual([]);
  expect(llm.script).toEqual([]); // el guion se cumplió entero
});

// ---------- cómo quedó todo ----------

/** Reservas del salón en hora local, en el orden en que se crearon. */
async function agenda() {
  const { rows } = await admin.query(
    `SELECT s.name AS service, r.name AS staff,
            to_char(b.starts_at AT TIME ZONE $2, 'YYYY-MM-DD HH24:MI') AS starts,
            b.status, br.is_active AS occupies
       FROM bookings b
       JOIN services s ON s.id = b.service_id
       LEFT JOIN booking_resources br ON br.booking_id = b.id
       LEFT JOIN resources r ON r.id = br.resource_id
      WHERE b.tenant_id = $1
      ORDER BY b.created_at`,
    [AURORA.tenant, TZ],
  );
  return rows;
}

/** Herramientas que ejecutó el agente en esta sesión, en orden (de la traza guardada). */
async function toolsCalled(sessionId: string) {
  const { rows } = await admin.query(
    `SELECT tc.name, tc.input, tc.result, tc.is_error
       FROM tool_calls tc JOIN conversations c ON c.id = tc.conversation_id
      WHERE c.channel = 'web' AND c.external_id = $1
      ORDER BY tc.id`,
    [sessionId],
  );
  return rows;
}

const names = (calls: { name: string }[]) => calls.map((c) => c.name);

/** Ejecuta un turno del cliente y devuelve solo las herramientas de ese turno. */
async function turn(sessionId: string, text: string, steps: Step[]) {
  llm.script = steps;
  const before = (await toolsCalled(sessionId)).length;
  const { reply, events } = await chat.send(sessionId, text);
  expect(events.at(-1)?.event).toBe("done");
  return { reply, tools: (await toolsCalled(sessionId)).slice(before) };
}

const serviceId = (p: Anthropic.MessageCreateParamsNonStreaming, name: string) =>
  findInHistory(p, "services").services.find((s: any) => s.name === name)?.service_id;

const ctx = (): ConversationContext => ({ tenantId: AURORA.tenant, locationId: AURORA.location, channel: "web" });
const freeTimes = async (service: string, date: string) =>
  (await bookings.checkAvailability(ctx(), { serviceId: service, date, partySize: 1, maxResults: 100 })).slots.map(
    (s) => s.time,
  );

// ---------- guiones reutilizables ----------

/** Reserva completa: consulta → contacto → aparta → (sí) confirma. Devuelve la sesión. */
async function bookWednesdayAt11(): Promise<string> {
  const sessionId = await chat.newSession();
  await turn(sessionId, "Hola, quiero un corte de mujer el miércoles a las 11", [
    call("list_services", {}),
    call("check_availability", (p) => ({
      service_id: serviceId(p, "Corte de mujer"),
      date: WED,
      party_size: 1,
      preferred_time: "11:00",
    })),
    (p) => {
      expect(lastToolResult(p).options.map((o: any) => o.time)).toContain("11:00");
      return say("El miércoles a las 11:00 tengo con Valeria. ¿Me das tu nombre y un teléfono o email?")(p);
    },
  ]);
  await turn(sessionId, "Rafael, 9 1234 5678, rafa@example.com", [
    call("save_customer_contact", { name: "Rafael", phone: "9 1234 5678", email: "rafa@example.com" }),
    call("hold_slot", (p) => ({ service_id: serviceId(p, "Corte de mujer"), date: WED, time: "11:00", party_size: 1 })),
    (p) => {
      expect(lastToolResult(p)).toMatchObject({ held: true });
      return say("Te aparté corte de mujer el miércoles 14 a las 11:00 con Valeria, a nombre de Rafael. ¿Lo confirmo?")(p);
    },
  ]);
  await turn(sessionId, "Sí", [
    call("confirm_booking", (p) => ({ booking_id: findInHistory(p, "booking_id").booking_id })),
    (p) => {
      expect(lastToolResult(p)).toMatchObject({ confirmed: true });
      return say("¡Listo, Rafael! Te esperamos el miércoles a las 11:00.")(p);
    },
  ]);
  return sessionId;
}

// ---------- casos ----------

describe("comportamiento del agente (Salón Aurora)", () => {
  it("reservar: consulta, pide contacto, aparta y confirma solo tras el sí", async () => {
    const sessionId = await chat.newSession();

    const first = await turn(sessionId, "Hola, quiero un corte de mujer el miércoles a las 11", [
      call("list_services", {}),
      call("check_availability", (p) => ({
        service_id: serviceId(p, "Corte de mujer"),
        date: WED,
        party_size: 1,
        preferred_time: "11:00",
      })),
      say("El miércoles a las 11:00 tengo con Valeria. ¿Me das tu nombre y un teléfono o email?"),
    ]);
    expect(names(first.tools)).toEqual(["list_services", "check_availability"]);
    expect(first.tools[1].result.options.map((o: any) => o.time)).toContain("11:00");
    expect(await agenda()).toEqual([]); // consultar no reserva nada

    const second = await turn(sessionId, "Rafael, 9 1234 5678, rafa@example.com", [
      call("save_customer_contact", { name: "Rafael", phone: "9 1234 5678", email: "rafa@example.com" }),
      call("hold_slot", (p) => ({ service_id: serviceId(p, "Corte de mujer"), date: WED, time: "11:00", party_size: 1 })),
      say("Te aparté corte de mujer el miércoles 14 a las 11:00 con Valeria. ¿Lo confirmo?"),
    ]);
    expect(names(second.tools)).toEqual(["save_customer_contact", "hold_slot"]);
    expect(second.tools[0].result).toMatchObject({ saved: true, phone: "+56912345678" });
    // apartado, todavía sin confirmar: el cliente no dijo que sí
    expect(await agenda()).toEqual([
      { service: "Corte de mujer", staff: "Valeria", starts: `${WED} 11:00`, status: "hold", occupies: true },
    ]);

    const third = await turn(sessionId, "Sí", [
      call("confirm_booking", (p) => ({ booking_id: findInHistory(p, "booking_id").booking_id })),
      say("¡Listo, Rafael! Te esperamos el miércoles a las 11:00."),
    ]);
    expect(names(third.tools)).toEqual(["confirm_booking"]);
    expect(third.tools[0].result).toMatchObject({ confirmed: true, status: "confirmed" });
    expect(await agenda()).toEqual([
      { service: "Corte de mujer", staff: "Valeria", starts: `${WED} 11:00`, status: "confirmed", occupies: true },
    ]);
    expect(await freeTimes(AURORA.services.corteMujer, WED)).toContain("11:00"); // Camila sigue libre
  });

  it("mover de día: un solo reschedule_booking, sin cancelar ni reservar aparte", async () => {
    const sessionId = await bookWednesdayAt11();

    const { tools } = await turn(sessionId, "¿Me la pasas al jueves a la misma hora?", [
      call("list_my_bookings", {}),
      call("check_availability", (p) => ({
        service_id: serviceId(p, "Corte de mujer"),
        date: THU,
        party_size: 1,
        preferred_time: "11:00",
      })),
      (p) => {
        expect(lastToolResult(p).options.map((o: any) => o.time)).toContain("11:00");
        return call("reschedule_booking", (q) => ({
          booking_id: findInHistory(q, "bookings").bookings[0].booking_id,
          date: THU,
          time: "11:00",
        }))(p);
      },
      say("Listo, quedó para el jueves 15 a las 11:00."),
    ]);

    expect(names(tools)).toEqual(["list_my_bookings", "check_availability", "reschedule_booking"]);
    expect(tools[2].result).toMatchObject({ rescheduled: true, status: "confirmed" });
    expect(await agenda()).toEqual([
      { service: "Corte de mujer", staff: "Valeria", starts: `${WED} 11:00`, status: "cancelled", occupies: false },
      { service: "Corte de mujer", staff: "Valeria", starts: `${THU} 11:00`, status: "confirmed", occupies: true },
    ]);
  });

  it("cancelar: libera el horario", async () => {
    const sessionId = await bookWednesdayAt11();

    const { tools } = await turn(sessionId, "Necesito cancelar mi corte del miércoles", [
      call("list_my_bookings", {}),
      (p) => call("cancel_booking", { booking_id: lastToolResult(p).bookings[0].booking_id })(p),
      say("Cancelada. ¡Gracias por avisar!"),
    ]);

    expect(names(tools)).toEqual(["list_my_bookings", "cancel_booking"]);
    expect(tools[1].result).toMatchObject({ cancelled: true });
    expect(await agenda()).toEqual([
      { service: "Corte de mujer", staff: "Valeria", starts: `${WED} 11:00`, status: "cancelled", occupies: false },
    ]);
    // Valeria vuelve a estar libre: el color (solo lo hace ella) entra a las 11:00
    expect(await freeTimes(AURORA.services.color, WED)).toContain("11:00");
  });

  it("algo ajeno al negocio (vuelos): responde sin herramientas y no toca la agenda", async () => {
    const sessionId = await chat.newSession();
    const { tools, reply } = await turn(sessionId, "¿Me reservas un vuelo a Bogotá para el viernes?", [
      say("Eso no lo puedo hacer: soy el asistente del Salón Aurora. ¿Te ayudo con una cita en el salón?"),
    ]);

    expect(tools).toEqual([]);
    expect(reply).toContain("Salón Aurora");
    expect(await agenda()).toEqual([]);
    const system = (llm.calls[0].system as Anthropic.TextBlockParam[])[0].text;
    expect(system).toContain("Temas ajenos al negocio");
  });

  it("un servicio que no existe: no está en la lista y el motor rechaza un id inventado", async () => {
    const sessionId = await chat.newSession();
    const { tools } = await turn(sessionId, "¿Hacen alisado brasileño el miércoles?", [
      call("list_services", {}),
      (p) => {
        const offered = lastToolResult(p).services.map((s: any) => s.name);
        expect(offered).not.toContain("Alisado brasileño");
        // si el modelo igual inventa el servicio, el motor no lo acepta
        return call("check_availability", { service_id: "alisado-brasileno", date: WED, party_size: 1 })(p);
      },
      say("No hacemos alisado brasileño. Tenemos corte, color, peinado y manicure. ¿Te interesa alguno?"),
    ]);

    expect(names(tools)).toEqual(["list_services", "check_availability"]);
    expect(tools[0].result.services.map((s: any) => s.name)).toEqual([
      "Color",
      "Corte de hombre",
      "Corte de mujer",
      "Manicure",
      "Peinado",
    ]);
    expect(tools[1]).toMatchObject({ is_error: true, result: { error: "service_not_found" } });
    expect(await agenda()).toEqual([]);
  });

  it("horarios imposibles: el motor no aparta y ofrece alternativas reales", async () => {
    const sessionId = await chat.newSession();

    // domingo: el salón cierra
    const sunday = await turn(sessionId, "Corte de mujer el domingo a las 10", [
      call("list_services", {}),
      call("check_availability", (p) => ({
        service_id: serviceId(p, "Corte de mujer"),
        date: SUN,
        party_size: 1,
        preferred_time: "10:00",
      })),
      say("Los domingos estamos cerrados. ¿Te sirve otro día?"),
    ]);
    expect(sunday.tools[1].result).toEqual({ date: SUN, options: [], reason: "closed" });

    // miércoles 18:30: un corte de 60 min terminaría después del cierre (19:00)
    await turn(sessionId, "Entonces el miércoles a las 6:30 de la tarde. Soy Ana, 9 5555 0000, ana@example.com", [
      call("save_customer_contact", { name: "Ana", phone: "9 5555 0000", email: "ana@example.com" }),
      call("hold_slot", (p) => ({ service_id: serviceId(p, "Corte de mujer"), date: WED, time: "18:30", party_size: 1 })),
      (p) => {
        const r = lastToolResult(p);
        expect(r).toMatchObject({ held: false, reason: "slot_unavailable" });
        return say(`A las 6:30 PM no alcanza antes del cierre. Puedo a las ${r.alternatives.at(-1).time}.`)(p);
      },
    ]);
    const [hold] = (await toolsCalled(sessionId)).filter((t) => t.name === "hold_slot");
    const alternatives: string[] = hold.result.alternatives.map((a: any) => a.time);
    expect(alternatives.length).toBeGreaterThan(0);
    expect(alternatives.every((t) => t <= "18:00")).toBe(true); // todas terminan antes de las 19:00

    expect(await agenda()).toEqual([]);
  });

  it("confirmar un apartado vencido: el motor lo rechaza, libera el horario y se vuelve a apartar", async () => {
    const sessionId = await chat.newSession();
    await turn(sessionId, "Corte de mujer el miércoles a las 11, soy Rafael, 912345678, rafa@example.com", [
      call("list_services", {}),
      call("save_customer_contact", { name: "Rafael", phone: "912345678", email: "rafa@example.com" }),
      call("hold_slot", (p) => ({ service_id: serviceId(p, "Corte de mujer"), date: WED, time: "11:00", party_size: 1 })),
      say("Te aparté el miércoles a las 11:00. ¿Lo confirmo?"),
    ]);

    // el cliente tarda 6 minutos en contestar (el apartado dura 5)
    now = new Date(now.getTime() + 6 * 60_000);

    const { tools } = await turn(sessionId, "Sí", [
      call("confirm_booking", (p) => ({ booking_id: findInHistory(p, "booking_id").booking_id })),
      (p) => {
        expect(lastToolResult(p)).toEqual({ confirmed: false, reason: "hold_expired" });
        // el agente no dice "listo": vuelve a apartar
        return call("hold_slot", (q) => ({ service_id: serviceId(q, "Corte de mujer"), date: WED, time: "11:00", party_size: 1 }))(p);
      },
      (p) => {
        expect(lastToolResult(p)).toMatchObject({ held: true });
        return say("El apartado había vencido, pero el horario sigue libre y te lo volví a apartar. ¿Lo confirmo?")(p);
      },
    ]);

    expect(names(tools)).toEqual(["confirm_booking", "hold_slot"]);
    expect(await agenda()).toEqual([
      { service: "Corte de mujer", staff: "Valeria", starts: `${WED} 11:00`, status: "expired", occupies: false },
      { service: "Corte de mujer", staff: "Valeria", starts: `${WED} 11:00`, status: "hold", occupies: true },
    ]);

    // y ahora sí, a tiempo
    await turn(sessionId, "Sí, confírmalo", [
      call("confirm_booking", (p) => ({ booking_id: findInHistory(p, "held").booking_id })),
      say("¡Listo! Te esperamos el miércoles a las 11:00."),
    ]);
    expect((await agenda()).map((b) => b.status)).toEqual(["expired", "confirmed"]);
  });
});
