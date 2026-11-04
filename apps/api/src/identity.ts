import { fromNodeHeaders } from "better-auth/node";
import type { IncomingHttpHeaders } from "node:http";
import type pg from "pg";
import type { Auth } from "./auth.js";

export type MerchantRole = "merchant_admin" | "merchant_staff";

export interface Identity {
  user: { id: string; name: string; email: string; locale: "es" | "en" | null };
  /** administrador de la plataforma (dueño del SaaS y su equipo) */
  platformAdmin: boolean;
  /** negocio activo de la sesión y el rol del usuario en él, si es miembro */
  business: {
    tenantId: string;
    organizationId: string;
    name: string;
    role: MerchantRole;
    /** suspendido: solo lectura; dado de baja: sin acceso (lo decide la plataforma) */
    status: "active" | "suspended" | "closed";
  } | null;
}

/** Roles de Better Auth (organización) → roles de la plataforma. */
export function merchantRole(memberRole: string): MerchantRole | null {
  const roles = memberRole.split(",").map((r) => r.trim());
  if (roles.includes("owner") || roles.includes("admin")) return "merchant_admin";
  if (roles.includes("member")) return "merchant_staff";
  return null;
}

/**
 * Quién hace la petición: sesión de Better Auth → negocio activo → membresía.
 * La membresía se revisa en cada petición (si lo sacan del negocio, pierde
 * acceso de inmediato). null si no hay sesión.
 */
export async function resolveIdentity(
  deps: { auth: Auth; authDb: pg.Pool; db: pg.Pool },
  headers: IncomingHttpHeaders,
): Promise<Identity | null> {
  const session = await deps.auth.api.getSession({ headers: fromNodeHeaders(headers) });
  if (!session) return null;
  const roles = String(session.user.role ?? "").split(",");
  const identity: Identity = {
    user: {
      id: session.user.id,
      name: session.user.name,
      email: session.user.email,
      locale: ((session.user as { locale?: string }).locale as "es" | "en" | undefined) ?? null,
    },
    platformAdmin: roles.includes("admin"),
    business: null,
  };

  const orgId = session.session.activeOrganizationId;
  if (!orgId) return identity;
  const member = await deps.authDb.query(`SELECT role FROM member WHERE "organizationId" = $1 AND "userId" = $2`, [
    orgId,
    session.user.id,
  ]);
  const role = member.rows[0] ? merchantRole(member.rows[0].role) : null;
  if (!role) return identity;
  // tenants no tiene RLS: es el índice de negocios (solo se lee id, nombre y estado)
  const tenant = await deps.db.query("SELECT id, name, status FROM tenants WHERE auth_organization_id = $1", [orgId]);
  if (!tenant.rows[0]) return identity;
  const t = tenant.rows[0];
  identity.business = { tenantId: t.id, organizationId: orgId, name: t.name, role, status: t.status };
  return identity;
}
