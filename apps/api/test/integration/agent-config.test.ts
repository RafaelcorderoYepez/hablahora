import type Anthropic from "@anthropic-ai/sdk";
import { Business, Service } from "@hablahora/contracts";
import { AgentRunner, BookingService, MemoryEmailSender, WebChatProcessor } from "@hablahora/core";
import { AURORA, seedSalonAurora } from "@hablahora/db";
import { DateTime } from "luxon";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAuth } from "../../src/auth.js";
import { AURORA_USERS, DEV_PASSWORD, seedAuroraUsers } from "../../src/seed-users.js";
import { buildServer } from "../../src/server.js";
import { browser, ORIGIN } from "../../../../test/support/auth.js";
import { call, FAKE_MODEL, FakeLlm, lastToolResult, say } from "../../../../test/support/fake-llm.js";
import { ADMIN_URL, APP_URL, AUTH_URL } from "../../../../test/support/global-setup.js";
import { chatClient } from "../../../../test/support/web-chat.js";

/** Configuración del agente (tono, información y derivación en dos idiomas) y chat activo. */

let admin: pg.Pool;
let app: pg.Pool;
let authDb: pg.Pool;
let auth: ReturnType<typeof createAuth>["auth"];
let server: ReturnType<typeof buildServer>;
let chat: ReturnType<typeof chatClient>;
let now: Date;
const llm = new FakeLlm();

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
  const runner = new AgentRunner({ db: app, bookings: new BookingService(app, clock), clock, model: FAKE_MODEL, llm: llm.client });
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
});

afterEach(() => expect(llm.stepErrors).toEqual([]));

async function valeria() {
  const b = browser(server.app);
  await b.signIn(AURORA_USERS.valeria.email, DEV_PASSWORD);
  const write = (method: "PATCH" | "POST", url: string, payload: unknown) =>
    server.app.inject({ method, url, payload: payload as any, headers: { cookie: b.cookie, origin: ORIGIN } });
  return { ...b, write };
}

/** Instrucciones que recibe el agente en el primer mensaje de una sesión nueva. */
async function promptFor(text = "Hola"): Promise<string> {
  const sessionId = await chat.newSession();
  llm.script = [say("Hola")];
  await chat.send(sessionId, text);
  return (llm.calls.at(-1)!.system as Anthropic.TextBlockParam[]).map((b) => b.text).join("\n");
}

describe("agente", () => {
  it("tono, información y derivación (en español e inglés) llegan a las instrucciones", async () => {
    const v = await valeria();
    const res = await v.write("PATCH", "/api/merchant/business", {
      agentTone: "brief",
      agentInstructions: "Estacionamiento gratis.",
      agentInstructionsEn: "Free parking.",
      agentHandoff: "- Si pide precio para novias.",
      agentHandoffEn: "- If they ask for bridal pricing.",
    });
    expect(Business.parse(res.json())).toMatchObject({ agentTone: "brief", agentInstructionsEn: "Free parking." });

    const prompt = await promptFor();
    expect(prompt).toContain("Respuestas muy breves y directas");
    expect(prompt).toContain("Estacionamiento gratis.");
    expect(prompt).toContain("Información del negocio en inglés");
    expect(prompt).toContain("Free parking.");
    expect(prompt).toContain("- Si pide precio para novias.");
    expect(prompt).toContain("- If they ask for bridal pricing.");
    expect(prompt).toContain("No anuncies los pasos que vas a dar");
  });

  it("el país del negocio llega a las instrucciones fijas: español de Chile y precios en pesos", async () => {
    const prompt = await promptFor();
    expect(prompt).toContain("El negocio está en Chile");
    expect(prompt).toContain('"pedir hora"');
    expect(prompt).toContain("en pesos chilenos");
    expect(prompt).toContain("No los conviertas a otra moneda.");
  });

  it("textos vacíos quedan sin dato; un tono inválido se rechaza", async () => {
    const v = await valeria();
    const res = await v.write("PATCH", "/api/merchant/business", { agentHandoff: "   ", agentInstructionsEn: "" });
    expect(res.json()).toMatchObject({ agentHandoff: null, agentInstructionsEn: null });
    expect(await promptFor()).not.toContain("en inglés (úsala tal cual");
    expect((await v.write("PATCH", "/api/merchant/business", { agentTone: "gracioso" })).statusCode).toBe(400);
  });

  it("los servicios llevan su versión en inglés al agente", async () => {
    const v = await valeria();
    const created = await v.write("POST", "/api/merchant/services", {
      name: "Alisado",
      description: "Con keratina.",
      nameEn: "Keratin smoothing",
      descriptionEn: "With keratin.",
      durationMin: 90,
      staffIds: [AURORA.staff.valeria],
    });
    const svc = Service.parse(created.json());
    expect(svc).toMatchObject({ nameEn: "Keratin smoothing", descriptionEn: "With keratin." });
    const cleared = await v.write("PATCH", `/api/merchant/services/${svc.id}`, { descriptionEn: "" });
    expect(cleared.json()).toMatchObject({ descriptionEn: null });

    const sessionId = await chat.newSession();
    llm.script = [
      call("list_services", {}),
      (p) => {
        const services = lastToolResult(p).services;
        expect(services.find((s: any) => s.name === "Alisado")).toEqual({
          service_id: svc.id,
          name: "Alisado",
          name_en: "Keratin smoothing",
          description: "Con keratina.",
          duration_min: 90,
        });
        // el precio llega formateado en la moneda del negocio (el Salón Aurora es de Chile)
        expect(services.find((s: any) => s.name === "Corte de mujer")).toMatchObject({ name_en: "Women's haircut", price: "$18.000", currency: "CLP" });
        return say("We have keratin smoothing.")(p);
      },
    ];
    await chat.send(sessionId, "What services do you have?");
    expect(llm.script).toEqual([]);
  });
});

describe("chat activo", () => {
  it("apagado: la página lo sabe, no abre sesiones ni responde, aunque la sesión ya existiera", async () => {
    const open = await chat.newSession();
    const v = await valeria();
    expect((await v.write("PATCH", "/api/merchant/business", { chatEnabled: false })).json()).toMatchObject({ chatEnabled: false });

    expect((await server.app.inject({ url: `/api/chat/${AURORA.slug}` })).json()).toMatchObject({ available: false });
    expect((await server.app.inject({ method: "POST", url: `/api/chat/${AURORA.slug}/sessions` })).statusCode).toBe(409);
    const msg = await chat.send(open, "¿Hay hora?");
    expect(msg.res.statusCode).toBe(409);
    expect(msg.res.json()).toMatchObject({ error: "chat_unavailable" });
    expect(llm.calls).toHaveLength(0);

    // con lo mínimo configurado se vuelve a activar
    expect((await v.write("PATCH", "/api/merchant/business", { chatEnabled: true })).statusCode).toBe(200);
    expect((await server.app.inject({ url: `/api/chat/${AURORA.slug}` })).json()).toMatchObject({ available: true });
  });

  it("sin lo mínimo no se activa, y el error dice qué falta", async () => {
    const v = await valeria();
    await v.write("PATCH", "/api/merchant/business", { chatEnabled: false });
    await admin.query("DELETE FROM availability_rules WHERE location_id = $1 AND resource_id IS NULL", [AURORA.location]);
    const res = await v.write("PATCH", "/api/merchant/business", { chatEnabled: true });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ reason: "chat_not_ready", details: { missing: ["hours"] } });
  });
});

describe("motivos de error para la consola", () => {
  it("cada error de negocio trae su motivo", async () => {
    const v = await valeria();
    await admin.query(
      `INSERT INTO tenants (id, name, vertical) VALUES ('c0c0c0c0-0000-4000-8000-000000000001', 'Otro', 'salon') ON CONFLICT DO NOTHING`,
    );
    await admin.query(
      `INSERT INTO locations (tenant_id, name, timezone, web_chat_slug) VALUES ('c0c0c0c0-0000-4000-8000-000000000001', 'X', 'UTC', 'ocupado')
       ON CONFLICT DO NOTHING`,
    );
    expect((await v.write("PATCH", "/api/merchant/business", { webChatSlug: "ocupado" })).json()).toMatchObject({
      error: "conflict",
      reason: "slug_taken",
    });
    expect((await v.write("POST", "/api/merchant/services", { name: "X", durationMin: 30, staffIds: [] })).json()).toMatchObject({
      error: "unprocessable",
      reason: "service_needs_staff",
    });
    await admin.query("DELETE FROM locations WHERE tenant_id = 'c0c0c0c0-0000-4000-8000-000000000001'");
    await admin.query("DELETE FROM tenants WHERE id = 'c0c0c0c0-0000-4000-8000-000000000001'");
  });
});
