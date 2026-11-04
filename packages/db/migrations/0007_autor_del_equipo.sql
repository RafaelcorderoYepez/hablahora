-- Quién del equipo escribió un mensaje (respuestas en el paso a humano).
-- Para los cambios de reserva, booking_events.actor ya guarda 'staff:<id del usuario>'.
ALTER TABLE conversation_messages ADD COLUMN author_user_id text;
