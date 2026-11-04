// Servidor para las pruebas de punta a punta (Playwright): Postgres embebido aparte,
// Salón Aurora sembrado, LLM simulado por reglas (sin gastar en el modelo) y las apps
// compiladas servidas por la API en app.localhost y chat.localhost, como en producción.
// Usa lo compilado: correr `npm run build` antes.
import EmbeddedPostgres from "embedded-postgres";
import { chmodSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { AgentRunner, BookingService, MemoryEmailSender, WebChatProcessor } from "@hablahora/core";
import { migrate, seedSalonAurora, AURORA } from "@hablahora/db";
import { createAuth } from "../apps/api/dist/auth.js";
import { seedAuroraUsers } from "../apps/api/dist/seed-users.js";
import { buildServer } from "../apps/api/dist/server.js";

export const E2E_PORT = Number(process.env.E2E_PORT ?? 4319);
const PG_PORT = 54339; // distinto del de Vitest (54329)
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const parent = mkdtempSync(join(tmpdir(), "hablahora-e2e-pg-"));
chmodSync(parent, 0o1777);
const postgres = new EmbeddedPostgres({
  databaseDir: join(parent, "data"),
  user: "postgres",
  password: "postgres",
  port: PG_PORT,
  persistent: false,
  onLog: () => {},
});
await postgres.initialise();
await postgres.start();
await postgres.createDatabase("hablahora_e2e");
const setup = postgres.getPgClient("hablahora_e2e");
await setup.connect();
await setup.query(`CREATE ROLE app_user LOGIN PASSWORD 'app_pw'`);
await setup.query(`CREATE ROLE auth_user LOGIN PASSWORD 'auth_pw'`);
await setup.end();
const url = (user, pw) => `postgres://${user}:${pw}@localhost:${PG_PORT}/hablahora_e2e`;
await migrate(url("postgres", "postgres"));

const admin = new pg.Pool({ connectionString: url("postgres", "postgres") });
const db = new pg.Pool({ connectionString: url("app_user", "app_pw") });
const consoleHost = `app.localhost:${E2E_PORT}`;
const chatHost = `chat.localhost:${E2E_PORT}`;
const consoleURL = `http://${consoleHost}`;
const { auth, pool: authDb } = createAuth({
  databaseUrl: url("auth_user", "auth_pw"),
  baseURL: consoleURL,
  secret: "secreto-de-e2e-0123456789-0123456789",
  trustedOrigins: [consoleURL],
  consoleURL,
  email: new MemoryEmailSender(),
});
await seedSalonAurora(admin);
await seedAuroraUsers({ auth, authDb, adminDb: admin, tenantId: AURORA.tenant, slug: AURORA.slug });

/**
 * LLM simulado por reglas: si el cliente pide una persona, pasa al equipo;
 * si no, saluda. Entrega el texto en dos partes, como el streaming real.
 */
let seq = 0;
const reply = (content, stop) => ({
  id: `msg_e2e_${++seq}`,
  type: "message",
  role: "assistant",
  model: "claude-sonnet-5-5",
  content,
  stop_reason: stop,
  stop_sequence: null,
  usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
});
const llm = async (params, opts) => {
  // el último mensaje del cliente o de las herramientas (después puede venir el contexto, role "system")
  const last = params.messages.findLast((m) => m.role !== "system");
  const blocks = Array.isArray(last.content) ? last.content : [{ type: "text", text: String(last.content) }];
  const text = (t) => {
    opts?.onText?.(t.slice(0, Math.ceil(t.length / 2)));
    opts?.onText?.(t.slice(Math.ceil(t.length / 2)));
    return reply([{ type: "text", text: t }], "end_turn");
  };
  if (blocks.some((b) => b.type === "tool_result")) return text("Te comunico con una persona del equipo.");
  const said = blocks.filter((b) => b.type === "text").map((b) => b.text).join(" ").toLowerCase();
  if (said.includes("persona")) {
    return reply([{ type: "tool_use", id: `toolu_e2e_${++seq}`, name: "request_human", input: { reason: "El cliente pide hablar con una persona" } }], "tool_use");
  }
  return text("¡Hola! Soy el asistente del Salón Aurora. ¿Qué servicio te interesa?");
};

const runner = new AgentRunner({ db, bookings: new BookingService(db), model: "claude-sonnet-5-5", llm });
const { app } = buildServer({
  webChat: new WebChatProcessor({ db, runner, log: { info() {}, warn() {}, error: console.error } }),
  auth: { auth, authDb, db, trustedOrigins: [consoleURL], chatPublicURL: `http://${chatHost}`, consoleURL },
  web: {
    hsts: false,
    connectSrc: [],
    sites: [
      { host: consoleHost, root: join(repo, "apps/console/dist"), frameable: false },
      { host: chatHost, root: join(repo, "apps/chat/dist"), frameable: true },
    ],
  },
});
await app.listen({ port: E2E_PORT, host: "127.0.0.1" });
console.info(`E2E listo: consola ${consoleURL} · chat http://${chatHost}`);

const stop = async () => {
  await app.close();
  await Promise.all([db.end(), authDb.end(), admin.end()]);
  await postgres.stop();
  process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
