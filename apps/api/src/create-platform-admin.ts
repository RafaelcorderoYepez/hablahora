// Crea un administrador de plataforma (no hay registro abierto).
//   npm run auth:create-admin -w @hablahora/api -- <email> "<nombre>"
// La contraseña se lee de la variable ADMIN_PASSWORD (no queda en el historial de la terminal).
import { LogEmailSender } from "@hablahora/core";
import { createAuth } from "./auth.js";

const [email, name] = process.argv.slice(2);
const password = process.env.ADMIN_PASSWORD;
if (!email || !name || !password) {
  console.error('Uso: ADMIN_PASSWORD=... npm run auth:create-admin -w @hablahora/api -- <email> "<nombre>"');
  process.exit(1);
}
const url = process.env.AUTH_DATABASE_URL;
const secret = process.env.BETTER_AUTH_SECRET;
if (!url || !secret) {
  console.error("Faltan AUTH_DATABASE_URL o BETTER_AUTH_SECRET");
  process.exit(1);
}
const { auth, pool } = createAuth({
  databaseUrl: url,
  baseURL: process.env.BETTER_AUTH_URL ?? "http://localhost:3000",
  secret,
  trustedOrigins: [],
  consoleURL: process.env.CONSOLE_URL ?? "http://localhost:3000",
  email: new LogEmailSender(),
});
try {
  const { user } = await auth.api.createUser({ body: { email, name, password, role: "admin" } });
  console.info(`Administrador de plataforma creado: ${user.email}`);
} finally {
  await pool.end();
}
