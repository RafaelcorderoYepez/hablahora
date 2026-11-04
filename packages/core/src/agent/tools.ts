import { DateTime } from "luxon";
import { formatMoney } from "@hablahora/contracts";
import { BookingError, type BookingService, type ConversationContext } from "../booking/service.js";
import type { EmailCodeService } from "../customers/email-code.js";

/**
 * Definiciones de tools para el LLM (formato de la API de Claude:
 * name / description / input_schema). Ningún tool recibe tenant ni sucursal,
 * y ninguno identifica al cliente: eso viene del ConversationContext que arma
 * el adaptador del canal.
 */
export const bookingTools = [
  {
    name: "list_services",
    description:
      "Lista los servicios que se pueden reservar en este negocio (p. ej. 'Mesa cena', 'Corte de pelo'), con su id, duración, precio y descripción. Úsalo antes de consultar disponibilidad si no sabes el service_id, y para responder qué incluye cada servicio.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "check_availability",
    description:
      "Consulta horarios disponibles para un servicio en una fecha. Devuelve hasta 4 opciones, las más cercanas a la hora preferida si se indica. Si no hay opciones, devuelve 'reason' para explicarle al cliente por qué (closed, fully_booked, party_too_large, outside_booking_window). Nunca inventes horarios: ofrece solo los que devuelve este tool.",
    input_schema: {
      type: "object",
      properties: {
        service_id: { type: "string" },
        date: { type: "string", description: "Fecha local del negocio, YYYY-MM-DD" },
        party_size: { type: "integer", minimum: 1, description: "Personas (1 para reservas individuales)" },
        preferred_time: { type: "string", description: "Hora aproximada que pidió el cliente, HH:mm (24 h)" },
      },
      required: ["service_id", "date", "party_size"],
      additionalProperties: false,
    },
  },
  {
    name: "hold_slot",
    description:
      "Aparta temporalmente un horario elegido por el cliente mientras confirma (expira en pocos minutos). Úsalo apenas el cliente elija una opción, antes de pedir la confirmación final. Si el horario se ocupó, devuelve alternativas para ofrecer.",
    input_schema: {
      type: "object",
      properties: {
        service_id: { type: "string" },
        date: { type: "string", description: "YYYY-MM-DD" },
        time: { type: "string", description: "HH:mm exactamente como lo devolvió check_availability" },
        party_size: { type: "integer", minimum: 1 },
        customer_name: { type: "string", description: "Nombre para la reserva, si el cliente lo dio" },
        notes: { type: "string", description: "Pedidos especiales: cumpleaños, silla de bebé, alergias" },
      },
      required: ["service_id", "date", "time", "party_size"],
      additionalProperties: false,
    },
  },
  {
    name: "confirm_booking",
    description:
      "Confirma una reserva apartada con hold_slot. Úsalo solo después de que el cliente aceptó explícitamente el resumen (servicio, fecha, hora, personas).",
    input_schema: {
      type: "object",
      properties: { booking_id: { type: "string" } },
      required: ["booking_id"],
      additionalProperties: false,
    },
  },
  {
    name: "list_my_bookings",
    description: "Lista las reservas próximas del cliente que está escribiendo.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "reschedule_booking",
    description:
      "Mueve una reserva existente del cliente a otro horario, en un solo paso: si el nuevo horario no está libre, la reserva original no cambia y se devuelven alternativas. Antes de llamarlo, verifica el horario con check_availability y confirma el cambio con el cliente.",
    input_schema: {
      type: "object",
      properties: {
        booking_id: { type: "string" },
        date: { type: "string", description: "Nueva fecha, YYYY-MM-DD" },
        time: { type: "string", description: "Nueva hora, HH:mm" },
        party_size: { type: "integer", minimum: 1, description: "Solo si cambia la cantidad de personas" },
      },
      required: ["booking_id", "date", "time"],
      additionalProperties: false,
    },
  },
  {
    name: "cancel_booking",
    description:
      "Cancela una reserva del cliente. Obtén el booking_id con list_my_bookings y confirma con el cliente cuál cancelar antes de llamarlo.",
    input_schema: {
      type: "object",
      properties: { booking_id: { type: "string" } },
      required: ["booking_id"],
      additionalProperties: false,
    },
  },
] as const;

/**
 * Solo en el chat web: ahí el canal no dice quién escribe. El contacto queda
 * asociado a esta conversación y sin verificar.
 */
export const saveCustomerContactTool = {
  name: "save_customer_contact",
  description:
    "Guarda el nombre y el teléfono y/o email que el cliente te dio en este chat, para poder apartar a su nombre. Úsalo apenas te los dé, antes de hold_slot. Puedes llamarlo de nuevo si corrige un dato.",
  input_schema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Nombre para la reserva" },
      phone: { type: "string", description: "Teléfono tal como lo escribió el cliente" },
      email: { type: "string", description: "Email tal como lo escribió el cliente" },
    },
    additionalProperties: false,
  },
} as const;

/**
 * Solo en el chat web: para ver, mover o cancelar reservas que el cliente no
 * hizo en esta conversación, prueba su email con un código.
 */
export const emailCodeTools = [
  {
    name: "request_email_code",
    description:
      "Envía un código de 6 dígitos al email del cliente. Úsalo solo cuando el cliente quiera ver, mover o cancelar una reserva que no hizo en esta conversación (list_my_bookings no la muestra). Para reservar no hace falta.",
    input_schema: {
      type: "object",
      properties: { email: { type: "string", description: "Email tal como lo escribió el cliente" } },
      required: ["email"],
      additionalProperties: false,
    },
  },
  {
    name: "verify_email_code",
    description:
      "Comprueba el código que el cliente recibió por email y escribió en el chat. Si es correcto, desde aquí puedes ver y gestionar todas sus reservas con ese email.",
    input_schema: {
      type: "object",
      properties: { code: { type: "string", description: "El código exactamente como lo escribió el cliente" } },
      required: ["code"],
      additionalProperties: false,
    },
  },
] as const;

export type BookingToolName =
  | (typeof bookingTools)[number]["name"]
  | typeof saveCustomerContactTool.name
  | (typeof emailCodeTools)[number]["name"];

export interface ToolServices {
  emailCodes?: EmailCodeService;
}

/**
 * Ejecuta un tool y devuelve un objeto serializable para el LLM.
 * Los errores esperables se devuelven como { error } en lugar de lanzarse,
 * para que el modelo pueda corregirse (p. ej. una fecha mal formateada).
 */
export async function handleBookingTool(
  service: BookingService,
  ctx: ConversationContext,
  name: string,
  input: Record<string, any>,
  services: ToolServices = {},
): Promise<unknown> {
  try {
    switch (name as BookingToolName) {
      case "list_services": {
        const services = await service.listServices(ctx);
        return {
          services: services.map((s) => ({
            service_id: s.id,
            name: s.name,
            duration_min: s.durationMin,
            ...(s.price != null ? { price: formatMoney(s.price, s.currency), currency: s.currency } : {}),
            ...(s.description ? { description: s.description } : {}),
            ...(s.nameEn ? { name_en: s.nameEn } : {}),
            ...(s.descriptionEn ? { description_en: s.descriptionEn } : {}),
          })),
        };
      }
      case "check_availability": {
        const r = await service.checkAvailability(ctx, {
          serviceId: str(input.service_id),
          date: str(input.date),
          partySize: int(input.party_size),
          preferredTime: input.preferred_time ? str(input.preferred_time) : undefined,
        });
        return r.slots.length
          ? { date: input.date, options: r.slots.map((s) => ({ date: s.date, time: s.time, with: s.resourceName })) }
          : { date: input.date, options: [], reason: r.reason };
      }
      case "hold_slot": {
        const r = await service.holdSlot(ctx, {
          serviceId: str(input.service_id),
          date: str(input.date),
          time: str(input.time),
          partySize: int(input.party_size),
          customerName: input.customer_name ? str(input.customer_name) : undefined,
          notes: input.notes ? str(input.notes) : undefined,
        });
        return r.ok
          ? { held: true, booking_id: r.booking.id, summary: summary(r.booking), expires_at: r.booking.holdExpiresAt }
          : {
              held: false,
              reason: r.reason,
              ...(r.missing ? { missing: r.missing } : {}),
              alternatives: r.alternatives.map((s) => ({ date: s.date, time: s.time, with: s.resourceName })),
            };
      }
      case "confirm_booking": {
        const r = await service.confirmBooking(ctx, str(input.booking_id));
        return r.ok
          ? { confirmed: r.booking.status === "confirmed", status: r.booking.status, summary: summary(r.booking) }
          : { confirmed: false, reason: r.reason };
      }
      case "list_my_bookings": {
        const list = await service.listMyBookings(ctx);
        return { bookings: list.map((b) => ({ booking_id: b.id, status: b.status, ...summary(b) })) };
      }
      case "reschedule_booking": {
        const r = await service.rescheduleBooking(ctx, str(input.booking_id), {
          date: str(input.date),
          time: str(input.time),
          partySize: input.party_size != null ? int(input.party_size) : undefined,
        });
        return r.ok
          ? { rescheduled: true, booking_id: r.booking.id, status: r.booking.status, summary: summary(r.booking) }
          : {
              rescheduled: false,
              reason: r.reason,
              ...(r.cutoffMinutes ? { cutoff_minutes: r.cutoffMinutes } : {}),
              alternatives: r.alternatives.map((s) => ({ date: s.date, time: s.time, with: s.resourceName })),
            };
      }
      case "cancel_booking": {
        const r = await service.cancelBooking(ctx, str(input.booking_id));
        return r.ok
          ? { cancelled: true, summary: summary(r.booking) }
          : { cancelled: false, reason: r.reason, ...(r.cutoffMinutes ? { cutoff_minutes: r.cutoffMinutes } : {}) };
      }
      case "save_customer_contact": {
        const r = await service.saveCustomerContact(ctx, {
          name: optStr(input.name),
          phone: optStr(input.phone),
          email: optStr(input.email),
        });
        if (!r.ok) return { saved: false, reason: r.reason };
        ctx.customerId = r.customerId; // las siguientes herramientas de esta conversación ya saben quién es
        return { saved: true, name: r.contact.name, phone: r.contact.phone, email: r.contact.email };
      }
      case "request_email_code": {
        if (!services.emailCodes) return { error: "unknown_tool", message: `Tool desconocido: ${name}` };
        const r = await services.emailCodes.requestCode(ctx, str(input.email));
        return r.ok ? { sent: true, email: r.email } : { sent: false, reason: r.reason };
      }
      case "verify_email_code": {
        if (!services.emailCodes) return { error: "unknown_tool", message: `Tool desconocido: ${name}` };
        const r = await services.emailCodes.verifyCode(ctx, str(input.code));
        return r.ok
          ? { verified: true, email: r.email }
          : { verified: false, reason: r.reason, ...(r.attemptsLeft != null ? { attempts_left: r.attemptsLeft } : {}) };
      }
      default:
        return { error: "unknown_tool", message: `Tool desconocido: ${name}` };
    }
  } catch (err) {
    if (err instanceof BookingError) return { error: err.code, message: err.message };
    throw err; // errores de infraestructura: que los maneje el orquestador
  }
}

/**
 * Línea de contexto para el system prompt: el modelo necesita "hoy" en la
 * zona del negocio para traducir "mañana" o "el viernes" a una fecha.
 */
export function dateContextLine(timezone: string, now: Date, locale = "es"): string {
  const d = DateTime.fromJSDate(now, { zone: timezone }).setLocale(locale);
  return `Hoy es ${d.toFormat("cccc d 'de' LLLL 'de' yyyy")} (${d.toISODate()}), son las ${d.toFormat("HH:mm")} en la zona horaria del negocio (${timezone}).`;
}

function summary(b: { serviceName: string; date: string; time: string; partySize: number; resourceNames: string[] }) {
  return { service: b.serviceName, date: b.date, time: b.time, party_size: b.partySize, with: b.resourceNames.join(", ") };
}

function str(v: unknown): string {
  if (typeof v !== "string" || !v.trim()) throw new BookingError("invalid_input", "Falta un parámetro de texto");
  return v.trim();
}

function optStr(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function int(v: unknown): number {
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1) {
    throw new BookingError("invalid_input", "party_size debe ser un entero >= 1");
  }
  return n;
}
