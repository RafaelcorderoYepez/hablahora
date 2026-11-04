// Textos de las métricas (H5, parte 2b), en español e inglés.

export const metricsEs = {
  title: "Métricas",
  subtitle: "Cómo le va a tu negocio: reservas, chat y ocupación del equipo.",
  period: "Período",
  last: (n: number) => `Últimos ${n} días`,
  booked: "Reservas",
  bookedHint: "Sin contar las canceladas",
  cancelled: "Canceladas",
  noShow: "No vinieron",
  conversion: "Chats con reserva",
  ofTotal: (n: number, total: number) => `${n} de ${total}`,
  perDay: "Reservas por día",
  perDayHint: "Por fecha de la reserva.",
  status: { confirmed: "Confirmadas", pending: "Por confirmar", completed: "Atendidas", noShow: "No vino", cancelled: "Canceladas" },
  bySource: "Por origen",
  source: { web: "Chat web", whatsapp: "WhatsApp", staff: "Equipo" } as Record<string, string>,
  topServices: "Servicios más reservados",
  chat: "El chat",
  conversations: "Conversaciones",
  withBooking: "Terminaron en reserva",
  handedOff: "Pasaron al equipo",
  teamReply: "El equipo tardó en responder",
  teamReplyValue: (min: number) => (min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${min % 60} min`),
  median: "mediana",
  occupancy: "Ocupación del equipo",
  occupancyHint: "Horas reservadas sobre horas de trabajo en el período.",
  hours: (booked: number, available: number) => `${fmtHours(booked)} de ${fmtHours(available)} h`,
  notWorking: "Sin horario en el período",
  none: "Sin datos en el período.",
};

function fmtHours(min: number): string {
  const h = min / 60;
  return Number.isInteger(h) ? String(h) : h.toFixed(1);
}

export type MetricsMessages = typeof metricsEs;

export const metricsEn: MetricsMessages = {
  title: "Insights",
  subtitle: "How your business is doing: bookings, chat and team utilization.",
  period: "Period",
  last: (n: number) => `Last ${n} days`,
  booked: "Bookings",
  bookedHint: "Not counting cancellations",
  cancelled: "Cancelled",
  noShow: "No-shows",
  conversion: "Chats with a booking",
  ofTotal: (n: number, total: number) => `${n} of ${total}`,
  perDay: "Bookings per day",
  perDayHint: "By appointment date.",
  status: { confirmed: "Confirmed", pending: "To confirm", completed: "Completed", noShow: "No-show", cancelled: "Cancelled" },
  bySource: "By source",
  source: { web: "Web chat", whatsapp: "WhatsApp", staff: "Team" },
  topServices: "Most booked services",
  chat: "The chat",
  conversations: "Conversations",
  withBooking: "Ended in a booking",
  handedOff: "Handed to the team",
  teamReply: "Team reply time",
  teamReplyValue: (min: number) => (min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${min % 60} min`),
  median: "median",
  occupancy: "Team utilization",
  occupancyHint: "Booked hours over working hours in the period.",
  hours: (booked: number, available: number) => `${fmtHours(booked)} of ${fmtHours(available)} h`,
  notWorking: "No hours in the period",
  none: "No data in the period.",
};
