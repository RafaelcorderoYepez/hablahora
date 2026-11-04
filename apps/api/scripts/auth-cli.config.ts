// Solo para generar el SQL del esquema de Better Auth con su CLI:
//   npx auth@1.7.7 generate --config scripts/auth-cli.config.ts
// El resultado se copia a una migración de packages/db (no se usa `auth migrate`).
import { LogEmailSender } from "@hablahora/core";
import { createAuth } from "../src/auth.js";

export const { auth } = createAuth({
  databaseUrl: process.env.AUTH_GEN_DATABASE_URL ?? "postgres://postgres:postgres_dev@localhost:5433/auth_gen",
  baseURL: "http://localhost:3000",
  secret: "solo-para-generar-el-esquema-0123456789",
  trustedOrigins: [],
  consoleURL: "http://localhost:3000",
  email: new LogEmailSender(),
});
