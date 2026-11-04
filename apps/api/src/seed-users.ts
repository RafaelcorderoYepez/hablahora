import type pg from "pg";
import type { Auth } from "./auth.js";

/** Contraseña de los usuarios de desarrollo (solo para el seed local). */
export const DEV_PASSWORD = "aurora-dev-2026";

export const AURORA_USERS = {
  platformAdmin: { email: "admin@hablahora.test", name: "Admin HablaHora" },
  valeria: { email: "valeria@salon-aurora.test", name: "Valeria" }, // merchant_admin (dueña)
  camila: { email: "camila@salon-aurora.test", name: "Camila" }, // merchant_staff
} as const;

/**
 * Usuarios y organización del Salón Aurora (correr después de seedSalonAurora).
 * Vuelve a crear todo cada vez: borra esos usuarios y la organización.
 */
export async function seedAuroraUsers(deps: {
  auth: Auth;
  authDb: pg.Pool; // rol auth_user
  adminDb: pg.Pool; // dueño del esquema: vincula el tenant
  tenantId: string;
  slug: string;
}): Promise<void> {
  const { auth, authDb } = deps;
  const emails = Object.values(AURORA_USERS).map((u) => u.email);
  await authDb.query(`DELETE FROM organization WHERE slug = $1`, [deps.slug]);
  await authDb.query(`DELETE FROM "user" WHERE email = ANY($1)`, [emails]);

  const create = async (u: { email: string; name: string }, role?: "admin") =>
    (await auth.api.createUser({ body: { ...u, password: DEV_PASSWORD, ...(role ? { role } : {}) } })).user;

  await create(AURORA_USERS.platformAdmin, "admin");
  const valeria = await create(AURORA_USERS.valeria);
  const camila = await create(AURORA_USERS.camila);

  // llamada de servidor sin cabeceras: crea la organización a nombre de Valeria (queda como owner)
  const org = await auth.api.createOrganization({
    body: { name: "Salón Aurora", slug: deps.slug, userId: valeria.id },
  });
  if (!org) throw new Error("No se pudo crear la organización del Salón Aurora");
  await auth.api.addMember({ body: { userId: camila.id, organizationId: org.id, role: "member" } });

  await deps.adminDb.query("UPDATE tenants SET auth_organization_id = $2 WHERE id = $1", [deps.tenantId, org.id]);
}
