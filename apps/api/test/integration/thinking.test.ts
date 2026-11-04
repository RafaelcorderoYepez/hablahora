import { AgentRunner, BookingService, WebChatProcessor } from "@hablahora/core";
import { AURORA, seedSalonAurora } from "@hablahora/db";
import { DateTime } from "luxon";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../../src/server.js";
import { call, contextOf, FAKE_MODEL, FakeLlm, say } from "../../../../test/support/fake-llm.js";
import { ADMIN_URL, APP_URL } from "../../../../test/support/global-setup.js";
import { chatClient } from "../../../../test/support/web-chat.js";

/**
 * Los bloques de pensamiento del modelo quedan ligados a todo lo anterior (`system`,
 * `tools` y mensajes). Si algo de eso cambia entre turnos, la API rechaza la llamada.
 * El LLM simulado aplica la misma comprobación: estos tests reproducen el chat que
 * se rompió (otro minuto y el cliente dejando sus datos a mitad del turno).
 */

let admin: pg.Pool;
let app: pg.Pool;
let server: ReturnType<typeof buildServer>;
let chat: ReturnType<typeof chatClient>;
let now: Date;
const llm = new FakeLlm();

beforeAll(async () => {
  admin = new pg.Pool({ connectionString: ADMIN_URL });
  app = new pg.Pool({ connectionString: APP_URL, max: 10 });
  const clock = () => now;
  const runner = new AgentRunner({ db: app, bookings: new BookingService(app, clock), clock, model: FAKE_MODEL, llm: llm.client });
  server = buildServer({ webChat: new WebChatProcessor({ db: app, runner, clock, log: { info() {}, warn() {}, error() {} } }) });
  chat = chatClient(server.app, AURORA.slug);
});

afterAll(async () => {
  await server.app.close();
  await app.end();
  await admin.end();
});

beforeEach(async () => {
  await seedSalonAurora(admin);
  now = DateTime.fromISO("2026-10-12T15:18", { zone: AURORA.timezone }).toJSDate();
  llm.reset();
});

afterEach(() => expect(llm.stepErrors).toEqual([]));

const minuteLater = () => (now = new Date(now.getTime() + 60_000));

describe("pensamiento del modelo entre turnos", () => {
  it("otro minuto y el cliente dejando sus datos a mitad del turno: el system no cambia y nada se rechaza", async () => {
    const sessionId = await chat.newSession();
    llm.script = [say("¿Para qué día quieres el corte?")];
    await chat.send(sessionId, "Quiero un corte de mujer");

    minuteLater();
    llm.script = [
      call("save_customer_contact", { name: "Rafael Cordero", phone: "+56912345678", email: "rafa@example.com" }),
      say("Gracias, Rafael. ¿Te parece el miércoles a las 10?"),
    ];
    await chat.send(sessionId, "Rafael Cordero, 912345678, rafa@example.com");

    minuteLater();
    llm.script = [say("Perfecto.")];
    const last = await chat.send(sessionId, "Sí");
    expect(last.reply).toBe("Perfecto.");

    // el system es el mismo en todas las llamadas (lo que cambia va en mensajes de sistema)
    const systems = llm.calls.map((c) => JSON.stringify(c.system));
    expect(new Set(systems).size).toBe(1);
    expect(systems[0]).not.toContain("son las");

    // cada turno con su contexto; dentro del turno, uno nuevo cuando el cliente dejó sus datos
    expect(contextOf(llm.calls[0])).toContain("son las 15:18");
    expect(contextOf(llm.calls[1])).toContain("Aún no tienes los datos de contacto");
    expect(contextOf(llm.calls[2])).toContain("ya dejó sus datos");
    expect(contextOf(llm.calls[3])).toContain("son las 15:20");

    // las respuestas reenviadas llevan su pensamiento (no se descartó nada)
    const replayed = llm.calls[3].messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((b) => b.type === "thinking");
    expect(replayed).toHaveLength(3);

    // el cliente no ve el contexto en su chat
    const transcript = (await server.app.inject({ url: `/api/chat/${AURORA.slug}/sessions/${sessionId}/messages` })).json();
    expect(transcript.messages.map((m: { role: string }) => m.role)).toEqual(["customer", "agent", "customer", "agent", "customer", "agent"]);
  });

  it("si alguien edita el historial, el LLM simulado lo rechaza como la API (los tests sirven de alarma)", async () => {
    const sessionId = await chat.newSession();
    llm.script = [say("¡Hola!")];
    await chat.send(sessionId, "Hola");
    // editar un mensaje ya enviado invalida el pensamiento de la respuesta que vino después
    // (solo en esta conversación: la base la comparten los demás archivos de tests)
    await admin.query(
      `UPDATE conversation_messages SET content = '[{"type":"text","text":"Hola, editado"}]'
        WHERE id = (SELECT min(m.id) FROM conversation_messages m JOIN conversations c ON c.id = m.conversation_id
                     WHERE m.author = 'customer' AND c.channel = 'web' AND c.external_id = $1)`,
      [sessionId],
    );
    minuteLater();
    llm.script = [say("No debería llegar aquí")];
    await chat.send(sessionId, "¿Sigues ahí?");
    expect(llm.stepErrors).toHaveLength(1);
    expect(String(llm.stepErrors[0])).toContain("bound to a different conversation");
    llm.stepErrors = []; // esperado en este test
  });
});
