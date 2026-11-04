// Alta de un negocio nuevo desde la terminal (lo mismo que hace la consola de la plataforma).
//   npm run business:create -w @hablahora/api -- "Barbería Norte" duena@barberia.com "Marta" [--pais CL|US] [--en] [--tz America/Santiago] [--slug barberia-norte] [--plantilla barberia]
import { BusinessTemplate, Country } from "@hablahora/contracts";
import { LogEmailSender, organizationLocale } from "@hablahora/core";
import pg from "pg";
import { createAuth } from "./auth.js";
import { createBusiness } from "./business-create.js";

function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v == null) throw new Error(`Falta la variable de entorno ${name}`);
  return v;
}

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const value = args[i + 1];
  args.splice(i, 2);
  return value;
};
const en = args.includes("--en");
if (en) args.splice(args.indexOf("--en"), 1);
const timezone = flag("--tz");
const slug = flag("--slug");
const templateArg = flag("--plantilla");
const countryArg = flag("--pais");
const country = countryArg ? Country.safeParse(countryArg.toUpperCase()) : undefined;
const template = templateArg ? BusinessTemplate.safeParse(templateArg) : undefined;
const [name, email, ownerName] = args;
if (!name || !email || !ownerName || (template && !template.success) || (country && !country.success)) {
  console.error(
    'Uso: npm run business:create -w @hablahora/api -- "<negocio>" <email del dueño> "<nombre del dueño>" [--pais CL|US] [--en] [--tz <zona>] [--slug <enlace>] [--plantilla salon|barberia|clinica|estetica]',
  );
  process.exit(1);
}

const db = new pg.Pool({ connectionString: env("DATABASE_URL") });
const consoleURL = env("CONSOLE_URL", "http://localhost:5174");
const { auth, pool: authDb } = createAuth({
  databaseUrl: env("AUTH_DATABASE_URL"),
  baseURL: env("BETTER_AUTH_URL", "http://localhost:3000"),
  secret: env("BETTER_AUTH_SECRET"),
  trustedOrigins: [],
  consoleURL,
  email: new LogEmailSender(),
  organizationLocale: (orgId) => organizationLocale(db, orgId),
});
try {
  const created = await createBusiness(
    { auth, authDb, db, consoleURL },
    { name, owner: { email, name: ownerName }, country: country?.data, locale: en ? "en" : undefined, timezone, slug, template: template?.data },
  );
  console.info(`Negocio creado: ${name}`);
  console.info(`  chat: /api/chat/${created.slug} (se activa al configurarlo)`);
  console.info(
    created.existingOwner
      ? `  ${email} ya tenía cuenta: entra a la consola con su contraseña`
      : `  ${email} recibió el correo para crear su contraseña (arriba, en el log)`,
  );
} finally {
  await authDb.end();
  await db.end();
}
