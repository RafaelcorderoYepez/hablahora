-- Descripción por servicio: la ve el cliente a través del agente (list_services)
-- y se edita en la consola del merchant.
ALTER TABLE services ADD COLUMN description text;
