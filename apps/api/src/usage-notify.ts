import { withTenant, type Db, type EmailSender } from "@hablahora/core";
import type pg from "pg";

/**
 * Aviso de que un negocio llegó al 80 % de las conversaciones de su plan en el
 * mes: a sus administradores y a los de la plataforma, cada uno en su idioma.
 * Al 100 % el chat deja de abrir conversaciones nuevas (las abiertas siguen).
 */
export function usageNotifier(deps: { db: Db; authDb: pg.Pool; email: EmailSender; consoleURL: string; log?: Pick<Console, "warn"> }) {
  return async (u: { tenantId: string; used: number; limit: number }): Promise<void> => {
    try {
      const { rows } = await deps.db.query("SELECT name, auth_organization_id FROM tenants WHERE id = $1", [u.tenantId]);
      const biz = rows[0];
      if (!biz) return;
      const defaultLocale = await withTenant(deps.db, u.tenantId, async (tx) => {
        const r = await tx.query("SELECT default_locale FROM locations ORDER BY created_at, id LIMIT 1");
        return r.rows[0]?.default_locale as string | undefined;
      });
      const recipients = await deps.authDb.query(
        `SELECT DISTINCT u.email, u.locale, false AS platform FROM member m JOIN "user" u ON u.id = m."userId"
          WHERE m."organizationId" = $1 AND m.role ~ '(^|,)\\s*(owner|admin)\\s*(,|$)'
         UNION
         SELECT u.email, u.locale, true AS platform FROM "user" u WHERE u.role ~ '(^|,)\\s*admin\\s*(,|$)'`,
        [biz.auth_organization_id],
      );
      const console = deps.consoleURL.replace(/\/+$/, "");
      for (const r of recipients.rows) {
        const en = (r.locale ?? defaultLocale) === "en";
        await deps.email.send(
          en
            ? {
                to: r.email,
                subject: `${biz.name}: 80% of this month's chat conversations used`,
                text: `${biz.name} has used ${u.used} of the ${u.limit} conversations included in its plan this month.\nWhen it reaches the limit, the chat won't start new conversations until next month (open ones continue).${r.platform ? `\n\nReview the business: ${console}/plataforma` : ""}`,
              }
            : {
                to: r.email,
                subject: `${biz.name}: se usó el 80 % de las conversaciones del mes`,
                text: `${biz.name} lleva ${u.used} de las ${u.limit} conversaciones que incluye su plan este mes.\nAl llegar al límite, el chat no abrirá conversaciones nuevas hasta el mes siguiente (las abiertas siguen).${r.platform ? `\n\nRevisa el negocio: ${console}/plataforma` : ""}`,
              },
        );
      }
    } catch (err) {
      deps.log?.warn("[plan] no se pudo avisar del uso", err);
    }
  };
}
