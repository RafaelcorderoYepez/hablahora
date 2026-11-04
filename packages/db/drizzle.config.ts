import { defineConfig } from "drizzle-kit";

// Por ahora las migraciones son SQL escrito a mano (`npm run db:new -- <nombre>`):
// RLS, EXCLUDE y funciones SECURITY DEFINER no se expresan bien en el esquema TS.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./migrations",
});
