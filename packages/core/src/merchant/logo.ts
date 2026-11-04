import type { Tx } from "../db/tenant.js";
import { MerchantError, primaryLocation } from "./common.js";

/** Tamaño máximo del logo (igual que la restricción de la tabla). */
export const MAX_LOGO_BYTES = 256 * 1024;

export type LogoMime = "image/png" | "image/jpeg" | "image/webp";

/**
 * Tipo real de la imagen por sus primeros bytes (no por lo que diga el navegador).
 * Solo PNG, JPEG y WebP: un SVG puede llevar código.
 */
export function detectImage(data: Buffer): LogoMime | null {
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  if (data.length >= 12 && data.toString("ascii", 0, 4) === "RIFF" && data.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return null;
}

/** Guarda (o reemplaza) el logo de la sucursal; devuelve cuándo cambió (para la URL con versión). */
export async function setLogo(tx: Tx, data: Buffer, now: Date): Promise<{ updatedAt: Date }> {
  if (data.length > MAX_LOGO_BYTES) throw new MerchantError("unprocessable", "El logo puede pesar hasta 256 KB", "logo_too_large");
  const mime = detectImage(data);
  if (!mime) throw new MerchantError("unprocessable", "El logo debe ser PNG, JPEG o WebP", "logo_invalid");
  const loc = await primaryLocation(tx);
  await tx.query(
    `INSERT INTO location_logos (location_id, tenant_id, mime, data, updated_at)
     VALUES ($1, current_setting('app.tenant_id')::uuid, $2, $3, $4)
     ON CONFLICT (location_id) DO UPDATE SET mime = EXCLUDED.mime, data = EXCLUDED.data, updated_at = EXCLUDED.updated_at`,
    [loc.id, mime, data, now],
  );
  return { updatedAt: now };
}

export async function deleteLogo(tx: Tx): Promise<void> {
  const loc = await primaryLocation(tx);
  await tx.query("DELETE FROM location_logos WHERE location_id = $1", [loc.id]);
}

/** Cuándo cambió el logo de una sucursal (null si no tiene). */
export async function logoVersion(tx: Tx, locationId: string): Promise<Date | null> {
  const { rows } = await tx.query("SELECT updated_at FROM location_logos WHERE location_id = $1", [locationId]);
  return rows[0]?.updated_at ?? null;
}

/** URL pública del logo, con versión: cambia al subir otro, así puede guardarse en caché para siempre. */
export const logoUrl = (slug: string, updatedAt: Date) => `/api/chat/${encodeURIComponent(slug)}/logo?v=${updatedAt.getTime()}`;
