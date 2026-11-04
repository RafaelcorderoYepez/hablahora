-- =====================================================================
-- Motor de reservas genérico (citas + mesas) — PostgreSQL 17
-- Multitenant con Row-Level Security. Horas en UTC (timestamptz);
-- reglas de horario en hora local de la sucursal.
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS btree_gist;   -- para evitar doble reserva
CREATE EXTENSION IF NOT EXISTS pgcrypto;     -- gen_random_uuid()

-- ---------------------------------------------------------------------
-- 1. Tenants y sucursales
-- ---------------------------------------------------------------------
CREATE TABLE tenants (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  vertical      text NOT NULL,                 -- 'restaurant' | 'salon' | 'clinic' | ...
  modules       text[] NOT NULL DEFAULT '{booking}', -- {booking, orders, faq}
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE locations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  name          text NOT NULL,
  timezone      text NOT NULL,                 -- 'America/New_York'
  wa_phone_number_id text UNIQUE,              -- resuelve el tenant desde el webhook
  address       text,
  agent_instructions text,                     -- tono, políticas, datos que el agente debe conocer
  default_locale text NOT NULL DEFAULT 'es',
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- 2. Recursos: lo que se ocupa en el tiempo
--    mesa, profesional, sala, equipo...
-- ---------------------------------------------------------------------
CREATE TABLE resources (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  location_id   uuid NOT NULL REFERENCES locations(id),
  kind          text NOT NULL,                 -- 'table' | 'staff' | 'room' | 'equipment'
  name          text NOT NULL,                 -- 'Mesa 12', 'Ana', 'Box 2'
  capacity_min  int  NOT NULL DEFAULT 1,       -- mesas: min comensales
  capacity_max  int  NOT NULL DEFAULT 1,       -- mesas: max comensales
  attributes    jsonb NOT NULL DEFAULT '{}',   -- {"zone":"terraza"}, {"skills":["color"]}
  is_active     boolean NOT NULL DEFAULT true,
  sort_order    int NOT NULL DEFAULT 0
);

-- Combinaciones de mesas (2+2 = mesa de 4-6). Opcional en el MVP.
CREATE TABLE resource_combinations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  location_id   uuid NOT NULL REFERENCES locations(id),
  resource_ids  uuid[] NOT NULL,
  capacity_min  int NOT NULL,
  capacity_max  int NOT NULL
);

-- ---------------------------------------------------------------------
-- 3. Servicios: lo que el cliente reserva
--    'Corte de pelo 45 min', 'Consulta', 'Mesa cena'
-- ---------------------------------------------------------------------
CREATE TABLE services (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  location_id      uuid NOT NULL REFERENCES locations(id),
  name             text NOT NULL,
  resource_kind    text NOT NULL,              -- qué tipo de recurso consume
  duration_min     int  NOT NULL,              -- duración base
  duration_rules   jsonb NOT NULL DEFAULT '[]',-- mesas: [{"party_max":2,"min":75},{"party_max":6,"min":105}]
  buffer_after_min int  NOT NULL DEFAULT 0,    -- limpieza / preparación
  price_cents      int,
  requires_deposit boolean NOT NULL DEFAULT false,
  is_active        boolean NOT NULL DEFAULT true
);

-- Qué recursos pueden prestar cada servicio (Ana hace color, Luis no)
CREATE TABLE service_resources (
  service_id    uuid NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  resource_id   uuid NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  PRIMARY KEY (service_id, resource_id)
);

-- ---------------------------------------------------------------------
-- 4. Disponibilidad
-- ---------------------------------------------------------------------
-- Reglas semanales recurrentes (hora local). resource_id NULL = toda la sucursal.
CREATE TABLE availability_rules (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  location_id   uuid NOT NULL REFERENCES locations(id),
  resource_id   uuid REFERENCES resources(id),
  weekday       smallint NOT NULL CHECK (weekday BETWEEN 0 AND 6), -- 0 = domingo
  start_time    time NOT NULL,
  end_time      time NOT NULL,                 -- si end < start, cruza medianoche
  valid_from    date,
  valid_until   date
);

-- Excepciones por fecha: feriados, vacaciones, horario especial
CREATE TABLE availability_exceptions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  location_id   uuid NOT NULL REFERENCES locations(id),
  resource_id   uuid REFERENCES resources(id),
  period        tstzrange NOT NULL,
  kind          text NOT NULL,                 -- 'closed' | 'open_override'
  reason        text
);

-- Políticas por sucursal o por servicio (service_id NULL = default de sucursal)
CREATE TABLE booking_policies (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid NOT NULL REFERENCES tenants(id),
  location_id            uuid NOT NULL REFERENCES locations(id),
  service_id             uuid REFERENCES services(id),
  slot_interval_min      int NOT NULL DEFAULT 15,   -- grilla de horarios ofrecidos
  min_lead_time_min      int NOT NULL DEFAULT 60,   -- no reservar con menos de X
  max_advance_days       int NOT NULL DEFAULT 60,
  cancel_cutoff_min      int NOT NULL DEFAULT 120,
  max_party_size         int,
  pacing_max_covers      int,                       -- restaurantes: máx comensales por intervalo
  hold_ttl_sec           int NOT NULL DEFAULT 300,  -- vida de un hold durante el chat
  auto_confirm           boolean NOT NULL DEFAULT true,
  UNIQUE (location_id, service_id)
);

-- ---------------------------------------------------------------------
-- 5. Clientes (identificados por teléfono de WhatsApp)
-- ---------------------------------------------------------------------
CREATE TABLE customers (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  phone_e164    text NOT NULL,                 -- '+13055551234'
  name          text,
  locale        text DEFAULT 'es',
  notes         text,                          -- alergias, preferencias (las ve el negocio)
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, phone_e164)
);

-- ---------------------------------------------------------------------
-- 6. Reservas
-- ---------------------------------------------------------------------
CREATE TYPE booking_status AS ENUM
  ('hold', 'pending', 'confirmed', 'seated', 'completed',
   'cancelled', 'no_show', 'expired');

CREATE TABLE bookings (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  location_id     uuid NOT NULL REFERENCES locations(id),
  service_id      uuid NOT NULL REFERENCES services(id),
  customer_id     uuid NOT NULL REFERENCES customers(id),
  starts_at       timestamptz NOT NULL,
  ends_at         timestamptz NOT NULL,        -- incluye duración, sin buffer
  party_size      int NOT NULL DEFAULT 1,
  status          booking_status NOT NULL DEFAULT 'hold',
  hold_expires_at timestamptz,                 -- solo para status = 'hold'
  source          text NOT NULL,               -- 'whatsapp' | 'voice' | 'web' | 'staff'
  conversation_id uuid,                        -- conversations.id (sin FK: también hay reservas sin chat)
  external_ref    text,                        -- id en Clover / Google Calendar
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);

CREATE INDEX bookings_location_time ON bookings (location_id, starts_at);
CREATE INDEX bookings_customer      ON bookings (customer_id, starts_at DESC);

-- Recursos ocupados por cada reserva. Aquí vive la garantía anti-doble-reserva.
CREATE TABLE booking_resources (
  booking_id    uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  resource_id   uuid NOT NULL REFERENCES resources(id),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  period        tstzrange NOT NULL,            -- [starts_at, ends_at + buffer)
  is_active     boolean NOT NULL DEFAULT true, -- false al cancelar/expirar
  PRIMARY KEY (booking_id, resource_id),
  EXCLUDE USING gist (resource_id WITH =, period WITH &&) WHERE (is_active)
);

-- Historial de cambios (quién movió qué: agente, staff, cliente)
CREATE TABLE booking_events (
  id            bigserial PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  booking_id    uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  event         text NOT NULL,                 -- 'created','confirmed','rescheduled','cancelled'
  actor         text NOT NULL,                 -- 'agent' | 'staff:<id>' | 'customer'
  payload       jsonb NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- 6b. Conversaciones del agente
-- ---------------------------------------------------------------------
-- Un hilo por cliente y sucursal (así funciona WhatsApp para el negocio).
CREATE TABLE conversations (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                uuid NOT NULL REFERENCES tenants(id),
  location_id              uuid NOT NULL REFERENCES locations(id),
  customer_phone           text NOT NULL,       -- E.164
  customer_profile_name    text,                -- nombre de perfil de WhatsApp
  handoff                  boolean NOT NULL DEFAULT false, -- true: atiende una persona, el agente calla
  handoff_reason           text,
  handoff_at               timestamptz,
  last_customer_message_at timestamptz,         -- para la ventana de 24 h de Meta
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (location_id, customer_phone)
);

-- Historial en el formato de mensajes de la API de Claude (bloques de contenido),
-- para poder reenviarlo tal cual al modelo.
CREATE TABLE conversation_messages (
  id              bigserial PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role            text NOT NULL CHECK (role IN ('user', 'assistant')),
  content         jsonb NOT NULL,
  author          text NOT NULL DEFAULT 'customer', -- 'customer' | 'agent' | 'tool' | 'staff'
  wa_message_id   text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX conversation_messages_conv ON conversation_messages (conversation_id, id);

-- Idempotencia del webhook: Meta reintenta entregas.
CREATE TABLE wa_inbound_events (
  wa_message_id text PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  received_at   timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- 7. Row-Level Security
--    La app hace: SET LOCAL app.tenant_id = '<uuid>' en cada transacción.
-- ---------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'locations','resources','resource_combinations','services','service_resources',
    'availability_rules','availability_exceptions','booking_policies',
    'customers','bookings','booking_resources','booking_events',
    'conversations','conversation_messages','wa_inbound_events'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
         USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)
         WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)', t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------
-- 8. Funciones que operan antes de conocer el tenant o sobre todos.
--    SECURITY DEFINER: su dueño debe ser superusuario o tener BYPASSRLS,
--    porque FORCE ROW LEVEL SECURITY también aplica al dueño de las tablas.
-- ---------------------------------------------------------------------

-- El webhook de WhatsApp trae phone_number_id; con esto se sabe el tenant.
CREATE FUNCTION resolve_wa_location(p_phone_number_id text)
RETURNS TABLE (tenant_id uuid, location_id uuid, timezone text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT l.tenant_id, l.id, l.timezone
  FROM locations l
  WHERE l.wa_phone_number_id = p_phone_number_id
$$;

-- Expirar holds abandonados. Correr cada minuto (pg_cron o un worker).
-- El servicio además los expira "en caliente" antes de cada hold.
CREATE FUNCTION expire_stale_holds(p_now timestamptz DEFAULT now())
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n integer;
BEGIN
  WITH expired AS (
    UPDATE bookings SET status = 'expired', updated_at = p_now
    WHERE status = 'hold' AND hold_expires_at < p_now
    RETURNING id
  )
  UPDATE booking_resources br SET is_active = false
  FROM expired e WHERE br.booking_id = e.id;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

-- Rol de la aplicación: sin BYPASSRLS, así RLS siempre aplica.
-- La migración lo crea sin login si no existe; cada entorno (Docker, tests,
-- producción) le da LOGIN y contraseña. Así no hay contraseñas en las migraciones.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user NOLOGIN;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO app_user;
GRANT EXECUTE ON FUNCTION resolve_wa_location(text), expire_stale_holds(timestamptz) TO app_user;

-- Tablas y secuencias que creen migraciones futuras (con este mismo rol) quedan
-- accesibles para la app. Las funciones se siguen otorgando una por una.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE ON SEQUENCES TO app_user;
