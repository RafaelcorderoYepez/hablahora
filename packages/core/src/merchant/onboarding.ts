import { COUNTRIES, RESERVED_SLUGS, type CountryCode, type Readiness } from "@hablahora/contracts";
import { withTenant, type Db, type Tx } from "../db/tenant.js";
import { primaryLocation } from "./common.js";

/**
 * Qué falta para que el chat atienda. Obligatorio: un servicio activo con un
 * profesional activo, horario del local y enlace del chat. Recomendado: que
 * el agente tenga información del negocio.
 */
export async function getReadiness(tx: Tx): Promise<Readiness> {
  const loc = await primaryLocation(tx);
  const { rows } = await tx.query(
    `SELECT
       EXISTS (SELECT 1 FROM services s
                 JOIN service_resources sr ON sr.service_id = s.id
                 JOIN resources r ON r.id = sr.resource_id
                WHERE s.location_id = $1 AND s.is_active AND r.is_active) AS services,
       EXISTS (SELECT 1 FROM availability_rules WHERE location_id = $1 AND resource_id IS NULL) AS hours,
       (SELECT web_chat_slug IS NOT NULL FROM locations WHERE id = $1) AS web_chat_slug,
       (SELECT coalesce(btrim(agent_instructions), '') <> '' FROM locations WHERE id = $1) AS agent_knowledge`,
    [loc.id],
  );
  const r = rows[0];
  const checks: Readiness["checks"] = [
    { key: "services", ok: r.services, required: true },
    { key: "hours", ok: r.hours, required: true },
    { key: "web_chat_slug", ok: r.web_chat_slug, required: true },
    { key: "agent_knowledge", ok: r.agent_knowledge, required: false },
  ];
  return { ready: checks.every((c) => c.ok || !c.required), checks };
}

export interface NewBusiness {
  name: string;
  /** decide la moneda (COUNTRIES); no se cambia después */
  country: CountryCode;
  timezone: string;
  locale: "es" | "en";
  /** enlace del chat; si ya existe, se le agrega un número */
  slug: string;
  /** id de la organización de Better Auth que la representa */
  organizationId: string;
  /** sin plan, el por defecto */
  planId?: string;
}

/**
 * Crea un negocio vacío (negocio + sucursal + políticas por defecto), listo
 * para configurarse desde la consola. El resto (servicios, equipo, horario)
 * lo carga el negocio.
 */
export async function createBusinessRecords(db: Db, b: NewBusiness): Promise<{ tenantId: string; locationId: string; slug: string }> {
  // tenants no tiene RLS: es el índice de negocios
  const { rows } = await db.query(
    // sin plan, el trigger pone el plan por defecto
    `INSERT INTO tenants (name, vertical, auth_organization_id, plan_id, country, currency)
     VALUES ($1, 'salon', $2, $3, $4, $5) RETURNING id`,
    [b.name, b.organizationId, b.planId ?? null, b.country, COUNTRIES[b.country].currency],
  );
  const tenantId: string = rows[0].id;
  return withTenant(db, tenantId, async (tx) => {
    const slug = await freeSlug(tx, b.slug);
    const loc = await tx.query(
      `INSERT INTO locations (tenant_id, name, timezone, default_locale, web_chat_slug)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [tenantId, b.name, b.timezone, b.locale, slug],
    );
    await tx.query("INSERT INTO booking_policies (tenant_id, location_id) VALUES ($1, $2)", [tenantId, loc.rows[0].id]);
    return { tenantId, locationId: loc.rows[0].id, slug };
  });
}

/** El slug pedido, o el mismo con -2, -3… si ya lo usa otro negocio. */
async function freeSlug(tx: Tx, base: string): Promise<string> {
  for (let n = 1; n < 100; n++) {
    const candidate = n === 1 ? base : `${base}-${n}`;
    if ((RESERVED_SLUGS as readonly string[]).includes(candidate)) continue;
    // resolve_web_location ve todos los negocios (SECURITY DEFINER); el resto pasa por RLS
    const { rowCount } = await tx.query("SELECT 1 FROM resolve_web_location($1)", [candidate]);
    if (!rowCount) return candidate;
  }
  throw new Error(`No hay un enlace libre para ${base}`);
}

/** Idioma del negocio de una organización de Better Auth (para el idioma de las invitaciones). */
export async function organizationLocale(db: Db, organizationId: string): Promise<"es" | "en"> {
  const { rows } = await db.query("SELECT id FROM tenants WHERE auth_organization_id = $1", [organizationId]);
  if (!rows[0]) return "es";
  return withTenant(db, rows[0].id, async (tx) => {
    const loc = await primaryLocation(tx).catch(() => null);
    if (!loc) return "es";
    const r = await tx.query("SELECT default_locale FROM locations WHERE id = $1", [loc.id]);
    return r.rows[0]?.default_locale === "en" ? "en" : "es";
  });
}

/** "Salón Aurora" → "salon-aurora". */
export function slugify(name: string): string {
  return (
    name
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "negocio"
  );
}
