#!/bin/bash
# Corre solo la primera vez que se crea el volumen.
# Crea el rol de la app (sin BYPASSRLS); los permisos los dan las migraciones.
set -euo pipefail
psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v pw="$APP_USER_PASSWORD" <<'SQL'
CREATE ROLE app_user LOGIN PASSWORD :'pw';
SQL
