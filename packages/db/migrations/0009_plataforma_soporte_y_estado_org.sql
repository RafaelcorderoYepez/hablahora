-- Consola del owner (H6, parte 2): registro de accesos de soporte y estado de un
-- negocio visible para Better Auth.

-- Quién de la plataforma vio las conversaciones de qué negocio, cuándo y por qué.
-- Es de la plataforma, no de un negocio: sin RLS, como tenants y plans.
CREATE TABLE support_access_log (
  id              bigserial PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  -- usuario de la plataforma (auth.user.id); sin FK: viven en otro esquema
  user_id         text NOT NULL,
  reason          text NOT NULL CHECK (length(btrim(reason)) >= 5),
  -- NULL = listado de conversaciones del negocio; si no, la conversación que vio
  conversation_id uuid,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX support_access_log_tenant_time ON support_access_log (tenant_id, created_at DESC);
CREATE INDEX support_access_log_time ON support_access_log (created_at DESC);

-- Better Auth corre con el rol auth_user, que no ve `tenants`: esta función le dice
-- el estado del negocio de una organización (activo, suspendido o dado de baja).
CREATE FUNCTION organization_status(p_organization_id text)
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT status FROM tenants WHERE auth_organization_id = p_organization_id
$$;
GRANT EXECUTE ON FUNCTION organization_status(text) TO auth_user;
