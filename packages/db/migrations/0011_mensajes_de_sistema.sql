-- Contexto del agente como mensajes de sistema dentro de la conversación (role 'system',
-- author 'system'): fecha y hora, idioma, si el cliente ya dejó sus datos. El `system`
-- de cada llamada queda fijo; así los bloques de pensamiento del modelo siguen siendo
-- válidos en los turnos siguientes (la API los liga a todo lo que había antes).
ALTER TABLE conversation_messages DROP CONSTRAINT conversation_messages_role_check;
ALTER TABLE conversation_messages ADD CONSTRAINT conversation_messages_role_check CHECK (role IN ('user', 'assistant', 'system'));
