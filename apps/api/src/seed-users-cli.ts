import { LogEmailSender } from "@hablahora/core";
import { AURORA } from "@hablahora/db";
import pg from "pg";
import { createAuth } from "./auth.js";
import { AURORA_USERS, DEV_PASSWORD, seedAuroraUsers } from "./seed-users.js";

function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v == null) throw new Error(`Falta la variable de entorno ${name}`);
  return v;
}

const { auth, pool: authDb } = createAuth({
  databaseUrl: env("AUTH_DATABASE_URL"),
  baseURL: env("BETTER_AUTH_URL", "http://localhost:3000"),
  secret: env("BETTER_AUTH_SECRET"),
  trustedOrigins: [],
  consoleURL: env("CONSOLE_URL", "http://localhost:3000"),
  email: new LogEmailSender(),
});
const adminDb = new pg.Pool({ connectionString: env("DATABASE_ADMIN_URL"), max: 1 });
try {
  await seedAuroraUsers({ auth, authDb, adminDb, tenantId: AURORA.tenant, slug: AURORA.slug });
  console.info(`Usuarios de desarrollo (contraseña: ${DEV_PASSWORD}):`);
  console.info(`  ${AURORA_USERS.platformAdmin.email}  administrador de plataforma`);
  console.info(`  ${AURORA_USERS.valeria.email}  merchant_admin del Salón Aurora`);
  console.info(`  ${AURORA_USERS.camila.email}  merchant_staff del Salón Aurora`);
} finally {
  await authDb.end();
  await adminDb.end();
}
