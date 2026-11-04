-- Estilo del chat público de cada sucursal: paleta (curada o color propio),
-- apariencia (claro/oscuro/automático) y mensaje de bienvenida por idioma.
-- La forma la valida packages/contracts (ChatSettings); NULL = valores por defecto.
ALTER TABLE locations ADD COLUMN chat_settings jsonb;

-- Idioma de cada conversación: lo usan los textos fijos (avisos, correo del
-- código) y la interfaz del chat. El agente igual responde en el idioma en que
-- le escriben. NULL = el idioma por defecto de la sucursal.
ALTER TABLE conversations ADD COLUMN locale text CHECK (locale IN ('es', 'en'));
