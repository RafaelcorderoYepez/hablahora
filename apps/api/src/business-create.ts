import { COUNTRIES, type BusinessTemplate, type CountryCode } from "@hablahora/contracts";
import { createBusinessRecords, platform, slugify } from "@hablahora/core";
import type pg from "pg";
import type { Auth } from "./auth.js";

export interface CreateBusinessInput {
  name: string;
  owner: { email: string; name: string };
  /** por defecto, Chile; la zona horaria y el idioma por defecto salen del país */
  country?: CountryCode;
  timezone?: string;
  locale?: "es" | "en";
  /** enlace del chat; por defecto, el nombre en minúsculas y con guiones */
  slug?: string;
  /** sin plan, el por defecto de la plataforma */
  planId?: string;
  /** servicios de ejemplo, horario típico y el dueño como profesional */
  template?: BusinessTemplate;
}

export interface CreatedBusiness {
  tenantId: string;
  organizationId: string;
  slug: string;
  ownerUserId: string;
  /** el dueño ya tenía cuenta (no se le manda correo de bienvenida) */
  existingOwner: boolean;
}

/**
 * Alta de un negocio nuevo, vacío, listo para configurarse desde la consola:
 * cuenta del dueño (sin contraseña), organización, negocio y sucursal. El
 * dueño recibe un correo para crear su contraseña. Lo usan la consola del owner y el script.
 */
export async function createBusiness(
  deps: { auth: Auth; authDb: pg.Pool; db: pg.Pool; consoleURL: string },
  input: CreateBusinessInput,
): Promise<CreatedBusiness> {
  const country = input.country ?? "CL";
  const locale = input.locale ?? COUNTRIES[country].locale;
  const email = input.owner.email.trim().toLowerCase();

  const existing = await deps.authDb.query(`SELECT id FROM "user" WHERE email = $1`, [email]);
  const ownerUserId: string =
    existing.rows[0]?.id ??
    (await deps.auth.api.createUser({ body: { email, name: input.owner.name, data: { locale } } })).user.id;

  const slug = slugify(input.slug ?? input.name);
  // la organización usa el mismo slug que el chat cuando está libre (los slugs de Better Auth son únicos aparte)
  const org = await deps.auth.api.createOrganization({
    body: { name: input.name, slug: `${slug}-${Date.now().toString(36)}`, userId: ownerUserId },
  });
  if (!org) throw new Error("No se pudo crear la organización");

  const records = await createBusinessRecords(deps.db, {
    name: input.name,
    country,
    timezone: input.timezone ?? COUNTRIES[country].timezone,
    locale,
    slug,
    organizationId: org.id,
    planId: input.planId,
  });
  if (input.template) await platform.applyTemplate(deps.db, records.tenantId, input.template, input.owner.name);

  if (!existing.rows[0]) {
    // correo de bienvenida con el enlace para crear la contraseña
    await deps.auth.api.requestPasswordReset({ body: { email, redirectTo: `${deps.consoleURL}/restablecer` } });
  }
  return { tenantId: records.tenantId, organizationId: org.id, slug: records.slug, ownerUserId, existingOwner: !!existing.rows[0] };
}
