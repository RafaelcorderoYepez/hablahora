import type Anthropic from "@anthropic-ai/sdk";
import { AURORA, seedSalonAurora } from "@hablahora/db";
import { AgentRunner, BookingService, EmailCodeService, MemoryEmailSender, WebChatProcessor } from "@hablahora/core";
import { DateTime } from "luxon";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../../src/server.js";
import { call, contextOf, FAKE_MODEL, FakeLlm, findInHistory, lastToolResult, say, type Step } from "../../../../test/support/fake-llm.js";
import { ADMIN_URL, APP_URL } from "../../../../test/support/global-setup.js";
import { chatClient } from "../../../../test/support/web-chat.js";

/**
 * Identificación del cliente del chat web: para reservar, nombre + teléfono +
 * email (sin código); para ver, mover o cancelar reservas de otra sesión,
 * un código al correo.
 */

const WED = "2026-10-14";
const EMAIL = "rafa@example.com";

let admin: pg.Pool;
let app: pg.Pool;
let now: Date;
let server: ReturnType<typeof buildServer>;
let chat: ReturnType<typeof chatClient>;
const llm = new FakeLlm();
const emails = new MemoryEmailSender();

beforeAll(async () => {
  admin = new pg.Pool({ connectionString: ADMIN_URL });
  app = new pg.Pool({ connectionString: APP_URL, max: 10 });
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
  server = buildServer({ webChat: new WebChatProcessor({ db: app, runner, clock, log: quiet }) });
  chat = chatClient(server.app, AURORA.slug);
});

afterAll(async () => {
  await server.app.close();
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

async function turn(sessionId: string, text: string, steps: Step[]) {
  llm.script = steps;
  return chat.send(sessionId, text);
}

/** El código del último correo a esa dirección (lo que el cliente leería). */
const codeSentTo = (email: string) => /\b(\d{6})\b/.exec(emails.lastTo(email)?.subject ?? "")?.[1];

const holdWed11: Step = call("hold_slot", {
  service_id: AURORA.services.corteMujer,
  date: WED,
  time: "11:00",
  party_size: 1,
});

/** Reserva el miércoles a las 11 en una sesión nueva, con los tres datos. */
async function bookInNewSession(): Promise<string> {
  const sessionId = await chat.newSession();
  await turn(sessionId, "Corte el miércoles a las 11. Rafael, 912345678, rafa@example.com", [
    call("save_customer_contact", { name: "Rafael", phone: "912345678", email: EMAIL }),
    holdWed11,
    call("confirm_booking", (p) => ({ booking_id: findInHistory(p, "booking_id").booking_id })),
    say("Listo."),
  ]);
  const { rows } = await admin.query("SELECT status FROM bookings WHERE tenant_id = $1", [AURORA.tenant]);
  expect(rows).toEqual([{ status: "confirmed" }]);
  return sessionId;
}

const statuses = async () => (await admin.query("SELECT status FROM bookings WHERE tenant_id = $1 ORDER BY created_at", [AURORA.tenant])).rows.map((r) => r.status);

describe("reservar en la web: nombre, teléfono y email, sin código", () => {
  it("si falta un dato, hold_slot dice cuál y no aparta", async () => {
    const sessionId = await chat.newSession();
    await turn(sessionId, "Corte el miércoles a las 11, soy Rafael, rafa@example.com", [
      call("save_customer_contact", { name: "Rafael", email: EMAIL }),
      holdWed11,
      (p) => {
        expect(lastToolResult(p)).toMatchObject({ held: false, reason: "customer_contact_required", missing: ["phone"] });
        return call("save_customer_contact", { phone: "9 1234 5678" })(p);
      },
      holdWed11,
      (p) => {
        expect(lastToolResult(p)).toMatchObject({ held: true });
        return say("Te aparté el miércoles a las 11:00. ¿Lo confirmo?")(p);
      },
    ]);
    expect(await statuses()).toEqual(["hold"]);
    expect(emails.sent).toEqual([]); // reservar no manda códigos
    // las instrucciones piden los tres datos
    const fixed = (llm.calls[0].system as Anthropic.TextBlockParam[])[0].text;
    expect(fixed).toContain("su nombre, su teléfono y su email");
  });
});

describe("gestionar reservas de otra sesión con un código al correo", () => {
  it("con el código correcto ve y cancela la reserva hecha en otra sesión", async () => {
    await bookInNewSession();
    const other = await chat.newSession();

    await turn(other, "Quiero cancelar mi corte del miércoles", [
      call("list_my_bookings", {}),
      (p) => {
        expect(lastToolResult(p)).toEqual({ bookings: [] }); // sin verificar no ve nada
        return say("¿Me das tu email para mandarte un código?")(p);
      },
    ]);
    await turn(other, EMAIL, [
      call("request_email_code", { email: "Rafa@Example.com" }),
      (p) => {
        expect(lastToolResult(p)).toEqual({ sent: true, email: EMAIL });
        return say("Te mandé un código a rafa@example.com. ¿Me lo dices?")(p);
      },
    ]);
    const code = codeSentTo(EMAIL)!;
    expect(code).toMatch(/^\d{6}$/);
    expect(emails.lastTo(EMAIL)!.text).toContain("Salón Aurora");

    const wrong = code === "000000" ? "111111" : "000000";
    await turn(other, wrong, [
      call("verify_email_code", { code: wrong }),
      (p) => {
        expect(lastToolResult(p)).toEqual({ verified: false, reason: "wrong_code", attempts_left: 4 });
        return say("Ese código no es. ¿Lo revisas?")(p);
      },
    ]);
    await turn(other, `es ${code.slice(0, 3)} ${code.slice(3)}`, [
      call("verify_email_code", { code: `${code.slice(0, 3)} ${code.slice(3)}` }),
      (p) => {
        expect(lastToolResult(p)).toEqual({ verified: true, email: EMAIL });
        return call("list_my_bookings", {})(p);
      },
      (p) => {
        const [booking] = lastToolResult(p).bookings;
        expect(booking).toMatchObject({ date: WED, time: "11:00", status: "confirmed" });
        return call("cancel_booking", { booking_id: booking.booking_id })(p);
      },
      (p) => {
        expect(lastToolResult(p)).toMatchObject({ cancelled: true });
        // la siguiente vuelta ya sabe que el email está verificado
        expect(contextOf(p)).toContain(`Verificó su email (${EMAIL})`);
        return say("Listo, cancelé tu corte del miércoles.")(p);
      },
    ]);

    expect(await statuses()).toEqual(["cancelled"]);
    const conv = await admin.query("SELECT verified_email FROM conversations WHERE external_id = $1", [other]);
    expect(conv.rows[0].verified_email).toBe(EMAIL);
  });

  it("verificar otro email no da acceso a las reservas de este", async () => {
    await bookInNewSession();
    const other = await chat.newSession();
    await turn(other, "ana@example.com", [call("request_email_code", { email: "ana@example.com" }), say("Te mandé un código.")]);
    const code = codeSentTo("ana@example.com")!;
    await turn(other, code, [
      call("verify_email_code", { code }),
      call("list_my_bookings", {}),
      (p) => {
        expect(lastToolResult(p)).toEqual({ bookings: [] });
        return say("No veo reservas con ese email.")(p);
      },
    ]);
  });

  it("el código vence a los 10 minutos", async () => {
    const sessionId = await chat.newSession();
    await turn(sessionId, EMAIL, [call("request_email_code", { email: EMAIL }), say("Te mandé un código.")]);
    const code = codeSentTo(EMAIL)!;
    now = new Date(now.getTime() + 11 * 60_000);
    await turn(sessionId, code, [
      call("verify_email_code", { code }),
      (p) => {
        expect(lastToolResult(p)).toEqual({ verified: false, reason: "expired" });
        return say("El código venció. ¿Te mando otro?")(p);
      },
    ]);
  });

  it("tras 5 intentos fallidos el código ya no sirve, aunque después llegue el correcto", async () => {
    const sessionId = await chat.newSession();
    await turn(sessionId, EMAIL, [call("request_email_code", { email: EMAIL }), say("Te mandé un código.")]);
    const code = codeSentTo(EMAIL)!;
    const wrong = code === "000000" ? "111111" : "000000";
    const results: unknown[] = [];
    for (let i = 0; i < 5; i++) {
      await turn(sessionId, wrong, [
        call("verify_email_code", { code: wrong }),
        (p) => {
          results.push(lastToolResult(p));
          return say("No es ese.")(p);
        },
      ]);
    }
    expect(results.at(-2)).toEqual({ verified: false, reason: "wrong_code", attempts_left: 1 });
    expect(results.at(-1)).toEqual({ verified: false, reason: "too_many_attempts" });
    await turn(sessionId, code, [
      call("verify_email_code", { code }),
      (p) => {
        expect(lastToolResult(p)).toEqual({ verified: false, reason: "too_many_attempts" });
        return say("Te mando un código nuevo si quieres.")(p);
      },
    ]);
  });

  it("un código nuevo reemplaza al anterior", async () => {
    const sessionId = await chat.newSession();
    await turn(sessionId, EMAIL, [call("request_email_code", { email: EMAIL }), say("Te mandé un código.")]);
    const first = codeSentTo(EMAIL)!;
    await turn(sessionId, "no me llegó", [call("request_email_code", { email: EMAIL }), say("Te mandé otro.")]);
    const second = codeSentTo(EMAIL)!;
    if (first !== second) {
      await turn(sessionId, first, [
        call("verify_email_code", { code: first }),
        (p) => {
          expect(lastToolResult(p)).toMatchObject({ verified: false, reason: "wrong_code" });
          return say("Ese es el código anterior.")(p);
        },
      ]);
    }
    await turn(sessionId, second, [
      call("verify_email_code", { code: second }),
      (p) => {
        expect(lastToolResult(p)).toEqual({ verified: true, email: EMAIL });
        return say("Listo.")(p);
      },
    ]);
  });

  it("máximo 3 envíos por hora por sesión y por email", async () => {
    const a = await chat.newSession();
    const sent: unknown[] = [];
    for (let i = 0; i < 4; i++) {
      await turn(a, EMAIL, [
        call("request_email_code", { email: EMAIL }),
        (p) => {
          sent.push(lastToolResult(p));
          return say("...")(p);
        },
      ]);
    }
    expect(sent.at(-1)).toEqual({ sent: false, reason: "rate_limited" });
    expect(emails.sent).toHaveLength(3);

    // otra sesión con el mismo email: también frenada (nadie llena el correo ajeno)
    const b = await chat.newSession();
    await turn(b, EMAIL, [
      call("request_email_code", { email: EMAIL }),
      (p) => {
        expect(lastToolResult(p)).toEqual({ sent: false, reason: "rate_limited" });
        return say("Ya mandamos varios códigos. Intenta en un rato.")(p);
      },
    ]);
    // pasada la hora, se puede de nuevo
    now = new Date(now.getTime() + 61 * 60_000);
    await turn(b, EMAIL, [
      call("request_email_code", { email: EMAIL }),
      (p) => {
        expect(lastToolResult(p)).toEqual({ sent: true, email: EMAIL });
        return say("Te mandé un código.")(p);
      },
    ]);
  });

  it("el código no se guarda: solo su hash", async () => {
    const sessionId = await chat.newSession();
    await turn(sessionId, EMAIL, [call("request_email_code", { email: EMAIL }), say("Te mandé un código.")]);
    const code = codeSentTo(EMAIL)!;
    const { rows } = await admin.query("SELECT * FROM email_verifications");
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0])).not.toContain(code);
    // y no queda en lo que vio el modelo ni en la traza
    const trace = await admin.query("SELECT result::text FROM tool_calls WHERE name = 'request_email_code'");
    expect(trace.rows[0].result).not.toContain(code);
  });
});
