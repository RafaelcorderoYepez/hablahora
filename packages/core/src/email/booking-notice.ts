import { DateTime } from "luxon";
import type { CustomerNotice } from "../booking/service.js";
import type { EmailMessage } from "./sender.js";

export type BookingNoticeKind = "confirmed" | "rescheduled" | "cancelled";

/**
 * Aviso al cliente cuando el negocio confirma, mueve o cancela su reserva desde
 * la consola, en el idioma del cliente. Sin email del cliente no hay aviso.
 */
export function bookingNoticeEmail(
  kind: BookingNoticeKind,
  notice: CustomerNotice,
  b: { serviceName: string; date: string; time: string; staffName?: string | null },
): EmailMessage | null {
  if (!notice.email) return null;
  const en = notice.locale === "en";
  const when = DateTime.fromISO(`${b.date}T${b.time}`)
    .setLocale(en ? "en-US" : "es")
    .toFormat(en ? "cccc, LLLL d 'at' h:mm a" : "cccc d 'de' LLLL 'a las' HH:mm");
  const hello = notice.name ? (en ? `Hi ${notice.name},` : `Hola, ${notice.name}:`) : en ? "Hi," : "Hola:";
  const what = b.staffName ? `${b.serviceName} ${en ? "with" : "con"} ${b.staffName}` : b.serviceName;

  const text = en
    ? {
        confirmed: [`Your booking at ${notice.business} is confirmed.`, `${what}, ${when}.`],
        rescheduled: [`${notice.business} moved your booking.`, `New time: ${what}, ${when}.`],
        cancelled: [`${notice.business} cancelled your booking.`, `It was: ${what}, ${when}.`],
      }[kind]
    : {
        confirmed: [`Tu reserva en ${notice.business} está confirmada.`, `${what}, ${when}.`],
        rescheduled: [`${notice.business} movió tu reserva.`, `Nuevo horario: ${what}, ${when}.`],
        cancelled: [`${notice.business} canceló tu reserva.`, `Era: ${what}, ${when}.`],
      }[kind];
  const subject = en
    ? { confirmed: "Booking confirmed", rescheduled: "Booking moved", cancelled: "Booking cancelled" }[kind]
    : { confirmed: "Reserva confirmada", rescheduled: "Reserva movida", cancelled: "Reserva cancelada" }[kind];
  const footer = en
    ? "If you have questions, reply through the business chat."
    : "Si tienes dudas, escríbele al negocio por su chat.";

  return { to: notice.email, subject: `${subject} — ${notice.business}`, text: [hello, ...text, footer].join("\n") };
}
