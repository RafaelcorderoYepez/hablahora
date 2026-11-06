import type pg from "pg";

/** Dueño y administradores de una organización (Better Auth): quienes reciben los avisos del negocio. */
export async function organizationAdmins(authDb: pg.Pool, organizationId: string): Promise<{ email: string; name: string; locale: string | null }[]> {
  const { rows } = await authDb.query(
    `SELECT u.email, u.name, u.locale FROM member m JOIN "user" u ON u.id = m."userId"
      WHERE m."organizationId" = $1 AND (m.role ~ '(^|,)\\s*(owner|admin)\\s*(,|$)')`,
    [organizationId],
  );
  return rows;
}
