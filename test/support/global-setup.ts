import EmbeddedPostgres from "embedded-postgres";
import { chmodSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "@hablahora/db";

export const PG_PORT = 54329;
export const ADMIN_URL = `postgres://postgres:postgres@localhost:${PG_PORT}/booking_test`;
export const APP_URL = `postgres://app_user:app_pw@localhost:${PG_PORT}/booking_test`;
export const AUTH_URL = `postgres://auth_user:auth_pw@localhost:${PG_PORT}/booking_test`;

let server: EmbeddedPostgres;

/** Levanta un Postgres real, crea los roles de la app y de Better Auth (sin BYPASSRLS) y aplica las migraciones. */
export async function setup() {
  // directorio aún inexistente: embedded-postgres lo crea con el dueño correcto
  // (importa si los tests corren como root, porque initdb usa otro usuario)
  const parent = mkdtempSync(join(tmpdir(), "booking-pg-"));
  chmodSync(parent, 0o1777);
  const databaseDir = join(parent, "data");
  server = new EmbeddedPostgres({
    databaseDir,
    user: "postgres",
    password: "postgres",
    port: PG_PORT,
    persistent: false,
    onLog: () => {},
  });
  await server.initialise();
  await server.start();
  await server.createDatabase("booking_test");

  const admin = server.getPgClient("booking_test");
  await admin.connect();
  await admin.query(`CREATE ROLE app_user LOGIN PASSWORD 'app_pw'`);
  await admin.query(`CREATE ROLE auth_user LOGIN PASSWORD 'auth_pw'`);
  await admin.end();
  await migrate(ADMIN_URL);
}

export async function teardown() {
  await server?.stop();
}
