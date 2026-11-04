-- =====================================================================
-- Usuarios de las consolas (Better Auth) e identificación del cliente
-- del chat web por código al correo.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Better Auth: esquema propio y rol propio. app_user no puede leer estas
-- tablas (contraseñas, sesiones), y auth_user no ve los datos de negocio.
-- Las tablas no llevan tenant_id: un usuario puede ser miembro de varios
-- negocios. SQL generado con `npx auth@1.7.7 generate` (ver apps/api/scripts).
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'auth_user') THEN
    CREATE ROLE auth_user NOLOGIN;
  END IF;
END $$;

CREATE SCHEMA auth;

create table auth."user" ("id" text not null primary key, "name" text not null, "email" text not null unique, "emailVerified" boolean not null, "image" text, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "updatedAt" timestamptz default CURRENT_TIMESTAMP not null, "role" text, "banned" boolean, "banReason" text, "banExpires" timestamptz);
create table auth."session" ("id" text not null primary key, "expiresAt" timestamptz not null, "token" text not null unique, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "updatedAt" timestamptz not null, "ipAddress" text, "userAgent" text, "userId" text not null references auth."user" ("id") on delete cascade, "impersonatedBy" text, "activeOrganizationId" text);
create table auth."account" ("id" text not null primary key, "accountId" text not null, "providerId" text not null, "userId" text not null references auth."user" ("id") on delete cascade, "accessToken" text, "refreshToken" text, "idToken" text, "accessTokenExpiresAt" timestamptz, "refreshTokenExpiresAt" timestamptz, "scope" text, "password" text, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "updatedAt" timestamptz not null);
create table auth."verification" ("id" text not null primary key, "identifier" text not null, "value" text not null, "expiresAt" timestamptz not null, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "updatedAt" timestamptz default CURRENT_TIMESTAMP not null);
create table auth."organization" ("id" text not null primary key, "name" text not null, "slug" text not null unique, "logo" text, "createdAt" timestamptz not null, "metadata" text);
create table auth."member" ("id" text not null primary key, "organizationId" text not null references auth."organization" ("id") on delete cascade, "userId" text not null references auth."user" ("id") on delete cascade, "role" text not null, "createdAt" timestamptz not null);
create table auth."invitation" ("id" text not null primary key, "organizationId" text not null references auth."organization" ("id") on delete cascade, "email" text not null, "role" text, "status" text not null, "expiresAt" timestamptz not null, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "inviterId" text not null references auth."user" ("id") on delete cascade);
create index "session_userId_idx" on auth."session" ("userId");
create index "account_userId_idx" on auth."account" ("userId");
create index "verification_identifier_idx" on auth."verification" ("identifier");
create index "member_organizationId_idx" on auth."member" ("organizationId");
create index "member_userId_idx" on auth."member" ("userId");
create index "invitation_organizationId_idx" on auth."invitation" ("organizationId");
create index "invitation_email_idx" on auth."invitation" ("email");

GRANT USAGE ON SCHEMA auth TO auth_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA auth TO auth_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA auth GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO auth_user;

-- Las funciones SECURITY DEFINER solo las llama la app (por defecto, cualquiera podía).
REVOKE EXECUTE ON FUNCTION resolve_wa_location(text), resolve_web_location(text),
  expire_stale_holds(timestamptz) FROM PUBLIC;

-- Cada negocio es una organización de Better Auth (sin FK: otro esquema y otro rol).
ALTER TABLE tenants ADD COLUMN auth_organization_id text UNIQUE;

-- ---------------------------------------------------------------------
-- Chat web: para ver, mover o cancelar reservas de otra sesión, el cliente
-- prueba su email con un código. La sesión verificada ve las reservas de
-- todos los clientes del negocio con ese email.
-- ---------------------------------------------------------------------
ALTER TABLE conversations ADD COLUMN verified_email text;
CREATE INDEX customers_email ON customers (tenant_id, lower(email)) WHERE email IS NOT NULL;

CREATE TABLE email_verifications (
  id              bigserial PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  email           text NOT NULL,              -- normalizado (minúsculas)
  code_hash       text NOT NULL,              -- sha256(salt:código); el código no se guarda
  salt            text NOT NULL,
  expires_at      timestamptz NOT NULL,
  attempts        int NOT NULL DEFAULT 0,
  consumed_at     timestamptz,
  created_at      timestamptz NOT NULL
);
CREATE INDEX email_verifications_email ON email_verifications (tenant_id, email, created_at);
CREATE INDEX email_verifications_conv ON email_verifications (conversation_id, created_at);

ALTER TABLE email_verifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_verifications FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON email_verifications
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
