-- =====================================================================
-- Conversaciones independientes del canal (WhatsApp y chat web),
-- registro de uso del modelo y traza de herramientas.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Clientes: teléfono y/o email. Solo se deduplican los verificados.
-- ---------------------------------------------------------------------
-- verified_via: cómo se probó el contacto. 'whatsapp' = el canal prueba el
-- teléfono. NULL = el cliente lo escribió en el chat web y nadie lo verificó;
-- esos clientes no se fusionan con otros, así nadie ve reservas ajenas
-- escribiendo un teléfono que no es suyo. La verificación se define en H2.
ALTER TABLE customers ALTER COLUMN phone_e164 DROP NOT NULL;
ALTER TABLE customers ADD COLUMN email text;
ALTER TABLE customers ADD COLUMN verified_via text;
UPDATE customers SET verified_via = 'whatsapp';   -- hasta ahora todos venían de WhatsApp
ALTER TABLE customers ADD CONSTRAINT customers_contact
  CHECK (phone_e164 IS NOT NULL OR email IS NOT NULL);
ALTER TABLE customers DROP CONSTRAINT customers_tenant_id_phone_e164_key;
CREATE UNIQUE INDEX customers_verified_phone ON customers (tenant_id, phone_e164)
  WHERE verified_via IS NOT NULL;

-- ---------------------------------------------------------------------
-- Conversaciones por (canal, id externo) en lugar de por teléfono.
-- whatsapp: external_id = teléfono E.164. web: id de sesión anónima.
-- ---------------------------------------------------------------------
ALTER TABLE conversations ADD COLUMN channel text;
ALTER TABLE conversations ADD COLUMN external_id text;
ALTER TABLE conversations ADD COLUMN customer_id uuid REFERENCES customers(id);
UPDATE conversations cv
   SET channel = 'whatsapp',
       external_id = cv.customer_phone,
       customer_id = (SELECT c.id FROM customers c
                       WHERE c.tenant_id = cv.tenant_id AND c.phone_e164 = cv.customer_phone
                         AND c.verified_via IS NOT NULL);
ALTER TABLE conversations ALTER COLUMN channel SET NOT NULL;
ALTER TABLE conversations ALTER COLUMN external_id SET NOT NULL;
ALTER TABLE conversations ADD CONSTRAINT conversations_channel CHECK (channel IN ('whatsapp', 'web'));
ALTER TABLE conversations DROP CONSTRAINT conversations_location_id_customer_phone_key;
ALTER TABLE conversations DROP COLUMN customer_phone;
ALTER TABLE conversations ADD CONSTRAINT conversations_external
  UNIQUE (location_id, channel, external_id);

-- ---------------------------------------------------------------------
-- Chat web: enlace público por sucursal.
-- ---------------------------------------------------------------------
ALTER TABLE locations ADD COLUMN web_chat_slug text UNIQUE
  CHECK (web_chat_slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$');

-- El chat público trae el slug; con esto se sabe el tenant (igual que resolve_wa_location).
CREATE FUNCTION resolve_web_location(p_slug text)
RETURNS TABLE (tenant_id uuid, location_id uuid, timezone text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT l.tenant_id, l.id, l.timezone
  FROM locations l
  WHERE l.web_chat_slug = p_slug
$$;
GRANT EXECUTE ON FUNCTION resolve_web_location(text) TO app_user;

-- ---------------------------------------------------------------------
-- Uso del modelo: una fila por llamada a la API de Claude.
-- ---------------------------------------------------------------------
CREATE TABLE llm_usage (
  id                          bigserial PRIMARY KEY,
  tenant_id                   uuid NOT NULL REFERENCES tenants(id),
  location_id                 uuid NOT NULL REFERENCES locations(id),
  conversation_id             uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  channel                     text NOT NULL,
  turn_id                     uuid NOT NULL,      -- agrupa las llamadas de un mismo mensaje del cliente
  model                       text NOT NULL,
  input_tokens                int NOT NULL DEFAULT 0,
  output_tokens               int NOT NULL DEFAULT 0,
  cache_read_input_tokens     int NOT NULL DEFAULT 0,
  cache_creation_input_tokens int NOT NULL DEFAULT 0,
  cost_usd                    numeric(12, 6),     -- estimado con los precios del momento; NULL si el modelo no tiene precio
  duration_ms                 int NOT NULL,
  stop_reason                 text,
  error                       text,               -- la llamada falló: tokens en 0
  created_at                  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX llm_usage_tenant_time ON llm_usage (tenant_id, created_at);
CREATE INDEX llm_usage_conv ON llm_usage (conversation_id, id);

-- ---------------------------------------------------------------------
-- Traza de herramientas: entrada, resultado y duración de cada llamada.
-- ---------------------------------------------------------------------
CREATE TABLE tool_calls (
  id              bigserial PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  llm_usage_id    bigint NOT NULL REFERENCES llm_usage(id) ON DELETE CASCADE, -- la llamada que la pidió
  tool_use_id     text NOT NULL,
  name            text NOT NULL,
  input           jsonb NOT NULL,
  result          jsonb NOT NULL,
  is_error        boolean NOT NULL,
  duration_ms     int NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tool_calls_conv ON tool_calls (conversation_id, id);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['llm_usage', 'tool_calls'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
         USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)
         WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)', t);
  END LOOP;
END $$;
