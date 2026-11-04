import pg from "pg";
import { AURORA, seedSalonAurora } from "./seed/salon-aurora.js";

const url = process.env.DATABASE_ADMIN_URL;
if (!url) {
  console.error("Falta la variable de entorno DATABASE_ADMIN_URL (rol dueño del esquema, no app_user)");
  process.exit(1);
}
const db = new pg.Pool({ connectionString: url, max: 1 });
try {
  await seedSalonAurora(db);
  console.info(`Salón Aurora listo: chat en /chat/${AURORA.slug}`);
} finally {
  await db.end();
}
