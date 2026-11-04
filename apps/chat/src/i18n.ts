export type Locale = "es" | "en";

const es = {
  online: "Responde al instante",
  placeholder: "Escribe tu mensaje",
  send: "Enviar",
  newChat: "Nueva conversación",
  language: "Idioma",
  welcome: (name: string) => `¡Hola! Soy el asistente de ${name}. ¿En qué te ayudo?`,
  you: "Tú",
  assistant: "Asistente",
  team: "Equipo",
  notSent: "No se envió",
  thinking: "Escribiendo…",
  tools: {
    list_services: "Revisando los servicios…",
    check_availability: "Buscando horarios…",
    hold_slot: "Apartando tu hora…",
    confirm_booking: "Confirmando tu reserva…",
    list_my_bookings: "Buscando tus reservas…",
    reschedule_booking: "Moviendo tu reserva…",
    cancel_booking: "Cancelando tu reserva…",
    save_customer_contact: "Guardando tus datos…",
    request_email_code: "Enviando el código a tu correo…",
    verify_email_code: "Revisando el código…",
    request_human: "Avisando al equipo…",
  } as Record<string, string>,
  handoff: "Una persona del equipo seguirá esta conversación y te responderá por aquí.",
  sessionLimit: "Esta conversación llegó a su límite de mensajes. Empieza una nueva para seguir.",
  rateLimited: "Abriste muchas conversaciones seguidas. Intenta de nuevo en un rato.",
  sendError: "No pudimos enviar tu mensaje. Revisa tu conexión e inténtalo de nuevo.",
  unavailableTitle: "Este chat todavía no está disponible",
  unavailable: "El negocio lo está preparando. Vuelve a intentarlo más tarde.",
  close: "Cerrar chat",
  notFoundTitle: "Este chat no existe",
  notFound: "Revisa el enlace que te compartió el negocio.",
  loadError: "No pudimos abrir el chat. Revisa tu conexión.",
  retry: "Reintentar",
  tooLong: (max: number) => `Máximo ${max} caracteres.`,
  poweredBy: "con",
  privacy: "Privacidad",
  privacyTitle: "Aviso de privacidad",
  privacyUpdated: (date: string) => `Actualizado el ${date}`,
  privacyMissing: "Todavía no hay un aviso de privacidad publicado.",
};

const en: typeof es = {
  online: "Replies instantly",
  placeholder: "Type your message",
  send: "Send",
  newChat: "New conversation",
  language: "Language",
  welcome: (name: string) => `Hi! I'm ${name}'s assistant. How can I help?`,
  you: "You",
  assistant: "Assistant",
  team: "Team",
  notSent: "Not sent",
  thinking: "Typing…",
  tools: {
    list_services: "Checking services…",
    check_availability: "Looking for times…",
    hold_slot: "Holding your time…",
    confirm_booking: "Confirming your booking…",
    list_my_bookings: "Looking up your bookings…",
    reschedule_booking: "Moving your booking…",
    cancel_booking: "Cancelling your booking…",
    save_customer_contact: "Saving your details…",
    request_email_code: "Sending the code to your email…",
    verify_email_code: "Checking the code…",
    request_human: "Letting the team know…",
  },
  handoff: "Someone from the team will take over this conversation and reply here.",
  sessionLimit: "This conversation reached its message limit. Start a new one to continue.",
  rateLimited: "You opened many conversations in a row. Please try again in a while.",
  sendError: "We couldn't send your message. Check your connection and try again.",
  unavailableTitle: "This chat isn't available yet",
  unavailable: "The business is still setting it up. Please try again later.",
  close: "Close chat",
  notFoundTitle: "This chat doesn't exist",
  notFound: "Check the link the business shared with you.",
  loadError: "We couldn't open the chat. Check your connection.",
  retry: "Try again",
  tooLong: (max: number) => `Up to ${max} characters.`,
  poweredBy: "with",
  privacy: "Privacy",
  privacyTitle: "Privacy notice",
  privacyUpdated: (date: string) => `Updated ${date}`,
  privacyMissing: "There's no privacy notice published yet.",
};

export const MESSAGES = { es, en };
export type Messages = typeof es;

/** Idioma del navegador si es español o inglés; si no, el del negocio. */
export function detectLocale(languages: readonly string[], fallback: Locale): Locale {
  for (const lang of languages) {
    const base = lang.toLowerCase().split("-")[0];
    if (base === "es" || base === "en") return base;
  }
  return fallback;
}

/** "Salón Aurora" → "SA"; "Barbería" → "BA". */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return (words[0] ?? "?").slice(0, 2).toUpperCase();
}
