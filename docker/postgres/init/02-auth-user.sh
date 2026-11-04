#!/bin/bash
# Corre solo la primera vez que se crea el volumen.
# Rol de Better Auth: solo ve el esquema auth (los permisos los dan las migraciones).
set -euo pipefail
psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v pw="$AUTH_USER_PASSWORD" <<'SQL'
CREATE ROLE auth_user LOGIN PASSWORD :'pw';
SQL
