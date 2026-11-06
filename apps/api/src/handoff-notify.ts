import { withTenant, type ConversationRow, type Db, type EmailSender } from "@hablahora/core";
import type pg from "pg";
import { organizationAdmins } from "./organization-admins.js";

/**
 * Aviso a los administradores del negocio cuando el agente pasa una conversación
 * al equipo (request_human o demasiadas vueltas), cada uno en su idioma, con el
 * enlace a la conversación en la consola. El staff lo ve en el contador del menú.
 */
export function handoffNotifier(deps: { db: Db; authDb: pg.Pool; email: EmailSender; consoleURL: string; log?: Pick<Console, "warn"> }) {
  return async (conv: ConversationRow, reason: string): Promise<void> => {
    try {
      const biz = await withTenant(deps.db, conv.tenantId, async (tx) => {
        const { rows } = await tx.query(
          `SELECT t.name, t.auth_organization_id, l.default_locale,
                  cu.name AS customer_name
             FROM conversations c
             JOIN locations l ON l.id = c.location_id
             JOIN tenants t ON t.id = c.tenant_id
             LEFT JOIN customers cu ON cu.id = c.customer_id
            WHERE c.id = $1`,
          [conv.id],
        );
        return rows[0];
      });
      if (!biz?.auth_organization_id) return;
      const admins = await organizationAdmins(deps.authDb, biz.auth_organization_id);
      const link = `${deps.consoleURL.replace(/\/+$/, "")}/conversaciones/${conv.id}`;
      for (const a of admins) {
        const en = (a.locale ?? biz.default_locale) === "en";
        const who = biz.customer_name ?? (en ? "A customer" : "Un cliente");
        await deps.email.send(
          en
            ? {
                to: a.email,
                subject: `${biz.name}: a conversation needs the team`,
                text: `${who} needs someone from the team in the chat (${reasonText(reason, true)}).\nThe assistant won't reply until you hand it back.\n\nOpen the conversation: ${link}`,
              }
            : {
                to: a.email,
                subject: `${biz.name}: una conversación necesita al equipo`,
                text: `${who} necesita a alguien del equipo en el chat (${reasonText(reason, false)}).\nEl agente no responderá hasta que se la devuelvas.\n\nAbre la conversación: ${link}`,
              },
        );
      }
    } catch (err) {
      // el aviso no debe romper la conversación
      deps.log?.warn("[handoff] no se pudo avisar a los administradores", err);
    }
  };
}

function reasonText(reason: string, en: boolean): string {
  if (reason === "max_tool_rounds") return en ? "the assistant couldn't resolve it" : "el agente no pudo resolverlo";
  return en ? `reason: ${reason}` : `motivo: ${reason}`;
}
