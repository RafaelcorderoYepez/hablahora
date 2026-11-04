import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { admin, organization } from "better-auth/plugins";
import { BRAND } from "@hablahora/contracts";
import type { EmailSender } from "@hablahora/core";
import pg from "pg";

export type Locale = "es" | "en";

export interface AuthOptions {
  /** Conexión con el rol auth_user (solo ve el esquema auth). */
  databaseUrl: string;
  /** URL pública de la API, p. ej. http://localhost:3000 */
  baseURL: string;
  secret: string;
  /** Orígenes desde los que se aceptan peticiones con cookie (las consolas). */
  trustedOrigins: string[];
  /** Dónde vive la consola, para los enlaces de invitación. */
  consoleURL: string;
  email: EmailSender;
  /** Idioma del negocio de una organización (para las invitaciones); por defecto, español. */
  organizationLocale?: (organizationId: string) => Promise<Locale>;
}

/** Roles de la organización que administran el negocio (merchant_admin). */
const ADMIN_ROLES = ["owner", "admin"];
const isAdminRole = (role: string) => role.split(",").some((r) => ADMIN_ROLES.includes(r.trim()));

/**
 * Usuarios de las consolas. Cada negocio es una organización de Better Auth
 * (tenants.auth_organization_id). Roles:
 *  - platform_admin: user.role = "admin" (plugin admin)
 *  - merchant_admin: miembro "owner" o "admin" de la organización
 *  - merchant_staff: miembro "member"
 * No hay registro abierto: solo se crea una cuenta si hay una invitación
 * pendiente para ese email. Los administradores de plataforma, por script.
 */
export function createAuth(opts: AuthOptions) {
  // search_path=auth: las tablas de Better Auth viven en su propio esquema
  const pool = new pg.Pool({ connectionString: opts.databaseUrl, options: "-c search_path=auth" });
  // sin manejador, una conexión cortada (p. ej. la base se reinicia) cerraría la API entera
  pool.on("error", (err) => console.error("[auth db] conexión perdida:", err.message));
  const orgLocale = async (orgId: string): Promise<Locale> => (await opts.organizationLocale?.(orgId)) ?? "es";

  /** ¿La cuenta todavía no tiene contraseña? (alta de un negocio nuevo: el enlace es de bienvenida) */
  const hasNoPassword = async (userId: string) => {
    const { rowCount } = await pool.query(
      `SELECT 1 FROM account WHERE "userId" = $1 AND "providerId" = 'credential' AND password IS NOT NULL`,
      [userId],
    );
    return !rowCount;
  };

  /** No dejar un negocio sin nadie que lo administre. */
  const assertAnotherAdmin = async (organizationId: string, memberId: string) => {
    const { rows } = await pool.query(`SELECT id, role FROM member WHERE "organizationId" = $1`, [organizationId]);
    if (!rows.some((m) => m.id !== memberId && isAdminRole(m.role))) {
      throw new APIError("BAD_REQUEST", {
        code: "LAST_ADMIN",
        message: "El negocio necesita al menos un administrador",
      });
    }
  };

  /**
   * Un negocio suspendido tiene los usuarios en solo lectura; uno dado de baja,
   * además, no acepta invitaciones. El estado lo fija la plataforma (tenants.status)
   * y auth_user lo lee con una función SECURITY DEFINER.
   */
  const assertBusinessEditable = async (organizationId: string, opts2: { suspendedAllowed?: boolean } = {}) => {
    const { rows } = await pool.query("SELECT public.organization_status($1) AS status", [organizationId]);
    const status = rows[0]?.status as string | null | undefined;
    if (status === "closed") {
      throw new APIError("FORBIDDEN", { code: "BUSINESS_CLOSED", message: "Este negocio fue dado de baja" });
    }
    if (status === "suspended" && !opts2.suspendedAllowed) {
      throw new APIError("FORBIDDEN", { code: "BUSINESS_SUSPENDED", message: "El negocio está suspendido" });
    }
  };

  const auth = betterAuth({
    database: pool,
    baseURL: opts.baseURL,
    basePath: "/api/auth",
    secret: opts.secret,
    // la consola siempre es de confianza (enlaces de invitación y de recuperar contraseña)
    trustedOrigins: [...new Set([...opts.trustedOrigins, new URL(opts.consoleURL).origin])],
    telemetry: { enabled: false },
    // Better Auth la apaga sola con NODE_ENV=test; siempre encendida, así los tests prueban lo real
    advanced: { disableOriginCheck: false },
    user: {
      additionalFields: {
        // idioma de la consola y de sus correos; lo cambia el propio usuario
        locale: { type: "string", required: false, input: true },
      },
    },
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 10,
      sendResetPassword: async ({ user, url }) => {
        const en = (user as { locale?: string }).locale === "en";
        // una cuenta sin contraseña es un alta (dueño de un negocio o administrador de plataforma)
        const welcome = await hasNoPassword(user.id);
        const platformAdmin = String((user as { role?: string }).role ?? "").split(",").includes("admin");
        await opts.email.send(
          welcome && platformAdmin
            ? en
              ? {
                  to: user.email,
                  subject: `You're invited to manage ${BRAND.name}`,
                  text: `You've been added as a platform administrator. Create your password here (the link expires in 1 hour):\n${url}`,
                }
              : {
                  to: user.email,
                  subject: `Te invitaron a administrar ${BRAND.name}`,
                  text: `Te agregaron como administrador de la plataforma. Crea tu contraseña aquí (el enlace vence en 1 hora):\n${url}`,
                }
            : welcome
            ? en
              ? {
                  to: user.email,
                  subject: `Welcome to ${BRAND.name}: create your password`,
                  text: `Your business is ready to set up. Create your password here (the link expires in 1 hour):\n${url}`,
                }
              : {
                  to: user.email,
                  subject: `Bienvenido a ${BRAND.name}: crea tu contraseña`,
                  text: `Tu negocio está listo para configurarse. Crea tu contraseña aquí (el enlace vence en 1 hora):\n${url}`,
                }
            : en
              ? {
                  to: user.email,
                  subject: `Reset your ${BRAND.name} password`,
                  text: `To choose a new password, open this link (it expires in 1 hour):\n${url}\n\nIf you didn't ask for it, ignore this email.`,
                }
              : {
                  to: user.email,
                  subject: `Recupera tu contraseña de ${BRAND.name}`,
                  text: `Para elegir una contraseña nueva, abre este enlace (vence en 1 hora):\n${url}\n\nSi no lo pediste, ignora este correo.`,
                },
        );
      },
    },
    plugins: [
      admin(),
      organization({
        // los negocios los da de alta la plataforma (script en H4, consola del owner en H6)
        allowUserToCreateOrganization: false,
        sendInvitationEmail: async (data) => {
          // quien recibe la invitación aún no tiene cuenta: va en el idioma del negocio
          const en = (await orgLocale(data.organization.id)) === "en";
          const link = `${opts.consoleURL}/invitacion/${data.id}`;
          await opts.email.send(
            en
              ? {
                  to: data.email,
                  subject: `You're invited to ${data.organization.name} on ${BRAND.name}`,
                  text: `${data.inviter.user.name} invited you to ${data.organization.name}.\nTo accept, open:\n${link}`,
                }
              : {
                  to: data.email,
                  subject: `Te invitaron a ${data.organization.name} en ${BRAND.name}`,
                  text: `${data.inviter.user.name} te invitó a ${data.organization.name}.\nPara aceptar, abre:\n${link}`,
                },
          );
        },
        organizationHooks: {
          // se invita como administrador o staff; dueño hay uno y no se transfiere por invitación
          beforeCreateInvitation: async ({ invitation, organization }) => {
            await assertBusinessEditable(organization.id);
            if (!["admin", "member"].includes(String(invitation.role))) {
              throw new APIError("BAD_REQUEST", { code: "INVALID_ROLE", message: "Invita como administrador o staff" });
            }
          },
          // negocio suspendido: usuarios en solo lectura; dado de baja: además no se aceptan invitaciones
          beforeCancelInvitation: async ({ organization }) => assertBusinessEditable(organization.id),
          beforeAcceptInvitation: async ({ organization }) => assertBusinessEditable(organization.id, { suspendedAllowed: true }),
          // aquí `organization` son los datos nuevos (sin id): el negocio es el de quien hace el cambio
          beforeUpdateOrganization: async ({ member }) => assertBusinessEditable(member.organizationId),
          beforeRemoveMember: async ({ member, organization }) => {
            await assertBusinessEditable(organization.id);
            if (isAdminRole(member.role)) await assertAnotherAdmin(organization.id, member.id);
          },
          beforeUpdateMemberRole: async ({ member, newRole, organization }) => {
            await assertBusinessEditable(organization.id);
            if (isAdminRole(member.role) && !isAdminRole(newRole)) await assertAnotherAdmin(organization.id, member.id);
          },
        },
      }),
    ],
    databaseHooks: {
      user: {
        create: {
          before: async (user, ctx) => {
            assertLocale(user.locale);
            // registro abierto apagado: solo con una invitación pendiente para ese email
            if (ctx?.path !== "/sign-up/email") return;
            const { rowCount } = await pool.query(
              `SELECT 1 FROM invitation
                WHERE lower(email) = lower($1) AND status = 'pending' AND "expiresAt" > now()`,
              [user.email],
            );
            if (!rowCount) return false;
          },
        },
        update: {
          before: async (user) => {
            assertLocale(user.locale);
          },
        },
      },
      session: {
        create: {
          // al ingresar, el negocio activo es el primero del que es miembro
          before: async (session) => {
            const { rows } = await pool.query(
              `SELECT "organizationId" FROM member WHERE "userId" = $1 ORDER BY "createdAt" LIMIT 1`,
              [session.userId],
            );
            return { data: { ...session, activeOrganizationId: rows[0]?.organizationId ?? null } };
          },
        },
      },
    },
  });

  return { auth, pool };
}

function assertLocale(value: unknown): void {
  if (value === undefined || value === null || value === "es" || value === "en") return;
  throw new APIError("BAD_REQUEST", { code: "INVALID_LOCALE", message: "Idioma inválido (es o en)" });
}

export type Auth = ReturnType<typeof createAuth>["auth"];
