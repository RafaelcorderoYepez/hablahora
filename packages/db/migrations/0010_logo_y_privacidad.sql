-- H7, parte 1: logo de cada negocio en su chat y aviso de privacidad de la plataforma.

-- Logo de la sucursal (PNG, JPEG o WebP, hasta 256 KB). En Postgres y no en un
-- servicio de archivos: es una imagen chica por negocio y así no hay otra pieza que operar.
CREATE TABLE location_logos (
  location_id uuid PRIMARY KEY REFERENCES locations(id) ON DELETE CASCADE,
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  mime        text NOT NULL CHECK (mime IN ('image/png', 'image/jpeg', 'image/webp')),
  data        bytea NOT NULL CHECK (octet_length(data) BETWEEN 1 AND 262144),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE location_logos ENABLE ROW LEVEL SECURITY;
ALTER TABLE location_logos FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON location_logos
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Aviso de privacidad del chat público (lo escribe la plataforma; sin texto, no hay enlace).
ALTER TABLE platform_settings
  ADD COLUMN privacy_es text,
  ADD COLUMN privacy_en text,
  ADD COLUMN privacy_updated_at timestamptz;
