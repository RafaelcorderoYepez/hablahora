-- Idioma de cada usuario de las consolas (es / en): la consola y sus correos
-- (recuperar contraseña) se muestran en ese idioma. NULL = el del navegador.
-- Better Auth lo maneja como campo adicional del usuario (apps/api/src/auth.ts).
ALTER TABLE auth."user" ADD COLUMN locale text CHECK (locale IN ('es', 'en'));
