import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate as drizzleMigrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

/** Carpeta con las migraciones SQL (sirve igual desde src/ y desde dist/). */
export const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));

/**
 * Aplica las migraciones pendientes, en una transacción.
 * Usar una conexión con un rol dueño del esquema (no `app_user`).
 */
export async function migrate(connectionString: string): Promise<void> {
  const pool = new pg.Pool({ connectionString, max: 1 });
  try {
    await drizzleMigrate(drizzle(pool), { migrationsFolder });
  } finally {
    await pool.end();
  }
}

export { seedSalonAurora, AURORA } from "./seed/salon-aurora.js";
