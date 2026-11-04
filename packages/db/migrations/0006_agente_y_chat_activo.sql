-- Contenido en inglés de los servicios (opcional): el agente lo usa con
-- clientes en inglés; si falta, traduce.
ALTER TABLE services ADD COLUMN name_en text;
ALTER TABLE services ADD COLUMN description_en text;

-- Instrucciones del agente en tres partes:
--   agent_tone                         estilo de las respuestas
--   agent_instructions (+ _en)         lo que el agente debe saber del negocio
--   agent_handoff (+ _en)              cuándo pasar la conversación a una persona
ALTER TABLE locations ADD COLUMN agent_tone text NOT NULL DEFAULT 'warm'
  CHECK (agent_tone IN ('warm', 'professional', 'brief'));
ALTER TABLE locations ADD COLUMN agent_instructions_en text;
ALTER TABLE locations ADD COLUMN agent_handoff text;
ALTER TABLE locations ADD COLUMN agent_handoff_en text;

-- El chat público atiende solo si el negocio lo activó (y para activarlo
-- necesita lo mínimo: servicio con profesional, horario y enlace).
-- Los negocios que ya existían quedan activos para no cortar su chat.
ALTER TABLE locations ADD COLUMN chat_enabled boolean NOT NULL DEFAULT false;
UPDATE locations SET chat_enabled = true;
