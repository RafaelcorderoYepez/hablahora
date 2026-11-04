import { migrate } from "./index.js";

const url = process.env.DATABASE_ADMIN_URL;
if (!url) {
  console.error("Falta la variable de entorno DATABASE_ADMIN_URL (rol dueño del esquema, no app_user)");
  process.exit(1);
}
await migrate(url);
console.info("Migraciones aplicadas");
