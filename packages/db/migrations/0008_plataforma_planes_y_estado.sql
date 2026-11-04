-- Consola del owner (H6, parte 1): planes con límites, estado de cada negocio,
-- modelo del agente por negocio y modelo por defecto de la plataforma.
-- Son datos de la plataforma, no de un negocio: sin RLS, como tenants.

CREATE TABLE plans (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                        text NOT NULL UNIQUE,
  -- NULL = sin límite
  max_conversations_per_month integer CHECK (max_conversations_per_month > 0),
  max_active_staff            integer CHECK (max_active_staff > 0),
  -- se guarda, pero en la v1 cada negocio tiene una sola sucursal
  max_locations               integer NOT NULL DEFAULT 1 CHECK (max_locations > 0),
  is_default                  boolean NOT NULL DEFAULT false,
  created_at                  timestamptz NOT NULL DEFAULT now()
);
-- un solo plan por defecto (el de los negocios nuevos)
CREATE UNIQUE INDEX plans_one_default ON plans (is_default) WHERE is_default;

INSERT INTO plans (name, max_conversations_per_month, max_active_staff, max_locations, is_default) VALUES
  ('Inicial', 300, 3, 1, true),
  ('Profesional', 1500, 10, 1, false);

ALTER TABLE tenants
  ADD COLUMN status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'closed')),
  ADD COLUMN status_changed_at timestamptz,
  ADD COLUMN plan_id uuid REFERENCES plans(id),
  -- NULL = el modelo por defecto de la plataforma
  ADD COLUMN agent_model text,
  -- mes ('YYYY-MM') en que ya se avisó que el negocio llegó al 80 % de conversaciones
  ADD COLUMN usage_warned_month text;

-- sin plan indicado, el plan por defecto (alta por script, seeds y negocios existentes)
CREATE FUNCTION tenants_default_plan() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.plan_id IS NULL THEN
    NEW.plan_id := (SELECT id FROM plans WHERE is_default);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tenants_default_plan BEFORE INSERT ON tenants FOR EACH ROW EXECUTE FUNCTION tenants_default_plan();

UPDATE tenants SET plan_id = (SELECT id FROM plans WHERE is_default);
ALTER TABLE tenants ALTER COLUMN plan_id SET NOT NULL;

-- Una sola fila: configuración global de la plataforma.
CREATE TABLE platform_settings (
  id            boolean PRIMARY KEY DEFAULT true CHECK (id),
  -- NULL = el de la variable CLAUDE_MODEL
  default_model text,
  updated_at    timestamptz NOT NULL DEFAULT now()
);
INSERT INTO platform_settings DEFAULT VALUES;
