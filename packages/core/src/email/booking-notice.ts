import { DateTime } from "luxon";
import type { BookingChange, CustomerNotice } from "../booking/service.js";
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
  const when = whenText(b, en);
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

function whenText(b: { date: string; time: string }, en: boolean): string {
  return DateTime.fromISO(`${b.date}T${b.time}`)
    .setLocale(en ? "en-US" : "es")
    .toFormat(en ? "cccc, LLLL d 'at' h:mm a" : "cccc d 'de' LLLL 'a las' HH:mm");
}

export interface BookingAlert {
  kind: BookingChange["kind"];
  business: string;
  serviceName: string;
  date: string;
  time: string;
  /** al mover: el horario anterior */
  previous?: { date: string; time: string } | null;
  staffName?: string | null;
  customer: { name: string | null; phone: string | null; email: string | null };
  notes?: string | null;
  /** la agenda de ese día en la consola */
  link: string;
}

/** Aviso a un administrador del negocio cuando un cliente reserva, mueve o cancela. */
export function bookingAlertEmail(a: BookingAlert, to: { email: string; locale: string }): EmailMessage {
  const en = to.locale === "en";
  const when = whenText(a, en);
  const title = en
    ? {
        confirmed: "New booking",
        requested: "Booking waiting for your confirmation",
        rescheduled: "A customer moved their booking",
        cancelled: "A customer cancelled their booking",
      }[a.kind]
    : {
        confirmed: "Nueva reserva",
        requested: "Reserva esperando tu confirmación",
        rescheduled: "Un cliente movió su reserva",
        cancelled: "Un cliente canceló su reserva",
      }[a.kind];
  const row = (label: string, value: string | null | undefined) => (value ? [`${label}: ${value}`] : []);
  const lines = [
    `${title}.`,
    "",
    ...row(en ? "Service" : "Servicio", a.serviceName),
    ...row(en ? "When" : "Cuándo", when),
    ...(a.previous ? row(en ? "It was" : "Antes era", whenText(a.previous, en)) : []),
    ...row(en ? "With" : "Con", a.staffName),
    ...row(en ? "Customer" : "Cliente", a.customer.name),
    ...row(en ? "Phone" : "Teléfono", a.customer.phone),
    ...row(en ? "Email" : "Correo", a.customer.email),
    ...row(en ? "Notes" : "Notas", a.notes),
    "",
    `${en ? "Open the agenda" : "Abre la agenda"}: ${a.link}`,
  ];
  return { to: to.email, subject: `${a.business}: ${title.toLowerCase()} (${when})`, text: lines.join("\n") };
}
