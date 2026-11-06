import { bookingAlertEmail, withTenant, type BookingChange, type Db, type EmailSender } from "@hablahora/core";
import type pg from "pg";
import { organizationAdmins } from "./organization-admins.js";

/** Fecha y hora de una reserva en la hora local del negocio. */
const LOCAL = (at: string, zone: string) =>
  `to_char(${at} AT TIME ZONE ${zone}, 'YYYY-MM-DD') AS date, to_char(${at} AT TIME ZONE ${zone}, 'HH24:MI') AS time`;

/**
 * Aviso a los administradores del negocio cuando un cliente reserva, mueve o
 * cancela, cada uno en su idioma. Lleva los datos del cliente y el enlace a la
 * agenda de ese día. Lo que hace el equipo desde la consola no se avisa.
 */
export function bookingNotifier(deps: { db: Db; authDb: pg.Pool; email: EmailSender; consoleURL: string; log?: Pick<Console, "warn"> }) {
  return async (change: BookingChange): Promise<void> => {
    try {
      const data = await withTenant(deps.db, change.tenantId, async (tx) => {
        const { rows } = await tx.query(
          `SELECT t.name AS business, t.auth_organization_id, l.default_locale, l.timezone,
                  ${LOCAL("b.starts_at", "l.timezone")}, b.notes, s.name AS service_name,
                  cu.name AS customer_name, cu.phone_e164, cu.email,
                  (SELECT string_agg(r.name, ', ' ORDER BY r.name)
                     FROM booking_resources br JOIN resources r ON r.id = br.resource_id
                    WHERE br.booking_id = b.id) AS staff_name
             FROM bookings b
             JOIN tenants t ON t.id = b.tenant_id
             JOIN locations l ON l.id = b.location_id
             JOIN services s ON s.id = b.service_id
             LEFT JOIN customers cu ON cu.id = b.customer_id
            WHERE b.id = $1`,
          [change.bookingId],
        );
        const previous = change.previousBookingId
          ? await tx.query(
              `SELECT ${LOCAL("b.starts_at", "l.timezone")} FROM bookings b JOIN locations l ON l.id = b.location_id WHERE b.id = $1`,
              [change.previousBookingId],
            )
          : null;
        return rows[0] ? { ...rows[0], previous: previous?.rows[0] as { date: string; time: string } | undefined } : null;
      });
      if (!data?.auth_organization_id) return;

      const alert = {
        kind: change.kind,
        business: data.business,
        serviceName: data.service_name,
        date: data.date,
        time: data.time,
        previous: data.previous ?? null,
        staffName: data.staff_name,
        customer: { name: data.customer_name, phone: data.phone_e164, email: data.email },
        notes: data.notes,
        link: `${deps.consoleURL.replace(/\/+$/, "")}/agenda?date=${data.date}`,
      };
      for (const a of await organizationAdmins(deps.authDb, data.auth_organization_id)) {
        await deps.email.send(bookingAlertEmail(alert, { email: a.email, locale: a.locale ?? data.default_locale }));
      }
    } catch (err) {
      // el aviso no debe romper la conversación: la reserva ya quedó hecha
      deps.log?.warn("[reservas] no se pudo avisar a los administradores", err);
    }
  };
}
