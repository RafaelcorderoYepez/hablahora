import pg from "pg";

// Las columnas `date` llegan como texto "YYYY-MM-DD", sin conversión a Date.
pg.types.setTypeParser(1082, (v) => v);

export type Db = pg.Pool;
export type Tx = pg.PoolClient;

/**
 * Ejecuta `fn` dentro de una transacción con el tenant fijado para RLS.
 * Todo acceso a datos de negocio pasa por aquí: si el código olvida filtrar
 * por tenant, la base igual no devuelve filas de otro negocio.
 */
export async function withTenant<T>(
  db: Db,
  tenantId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  const tx = await db.connect();
  try {
    await tx.query("BEGIN");
    await tx.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const result = await fn(tx);
    await tx.query("COMMIT");
    return result;
  } catch (err) {
    await tx.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    tx.release();
  }
}

/** Ejecuta `fn` dentro de un SAVEPOINT; si falla, deshace solo ese tramo. */
export async function savepoint<T>(tx: Tx, fn: () => Promise<T>): Promise<T> {
  await tx.query("SAVEPOINT sp");
  try {
    const result = await fn();
    await tx.query("RELEASE SAVEPOINT sp");
    return result;
  } catch (err) {
    await tx.query("ROLLBACK TO SAVEPOINT sp");
    throw err;
  }
}

export const EXCLUSION_VIOLATION = "23P01";

export function isExclusionViolation(err: unknown): boolean {
  return (err as { code?: string })?.code === EXCLUSION_VIOLATION;
}
