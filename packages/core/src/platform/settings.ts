import type { Db } from "../db/tenant.js";

/** Modelo por defecto de la plataforma; null = el de la variable CLAUDE_MODEL. */
export async function getDefaultModel(db: Db): Promise<string | null> {
  const { rows } = await db.query("SELECT default_model FROM platform_settings");
  return rows[0]?.default_model ?? null;
}

export async function setDefaultModel(db: Db, model: string | null): Promise<void> {
  await db.query("UPDATE platform_settings SET default_model = $1, updated_at = now()", [model]);
}

export interface PrivacyNotice {
  es: string | null;
  en: string | null;
  updatedAt: Date | null;
}

/** Aviso de privacidad del chat público (texto de la plataforma; vacío = sin enlace). */
export async function getPrivacy(db: Db): Promise<PrivacyNotice> {
  const { rows } = await db.query("SELECT privacy_es, privacy_en, privacy_updated_at FROM platform_settings");
  return { es: rows[0]?.privacy_es ?? null, en: rows[0]?.privacy_en ?? null, updatedAt: rows[0]?.privacy_updated_at ?? null };
}

export async function setPrivacy(db: Db, p: { es: string | null; en: string | null }, now: Date): Promise<void> {
  await db.query("UPDATE platform_settings SET privacy_es = $1, privacy_en = $2, privacy_updated_at = $3, updated_at = $3", [
    p.es,
    p.en,
    now,
  ]);
}
