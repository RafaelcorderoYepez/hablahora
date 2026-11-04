/**
 * Tipos de entrada y salida del motor de slots.
 * Mapean 1:1 a las tablas de motor_reservas_schema.sql.
 * Todas las fechas absolutas son Date (UTC); las horas de reglas son
 * hora local de la sucursal en formato "HH:mm".
 */

export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6; // 0 = domingo

export interface Resource {
  id: string;
  kind: string; // 'table' | 'staff' | 'room' | ...
  name?: string;
  capacityMin: number;
  capacityMax: number;
  isActive: boolean;
  sortOrder?: number;
}

export interface DurationRule {
  partyMax: number; // aplica a grupos de hasta N personas
  min: number; // duración en minutos
}

export interface Service {
  id: string;
  resourceKind: string;
  durationMin: number;
  durationRules?: DurationRule[];
  bufferAfterMin: number;
  /** ids de recursos habilitados para este servicio (service_resources) */
  resourceIds: string[];
}

export interface AvailabilityRule {
  /** null = regla de toda la sucursal */
  resourceId: string | null;
  weekday: Weekday;
  startTime: string; // "HH:mm" local
  endTime: string; // "HH:mm" local; si <= startTime, cruza medianoche
  validFrom?: string; // "YYYY-MM-DD"
  validUntil?: string; // "YYYY-MM-DD"
}

export interface AvailabilityException {
  /** null = aplica a toda la sucursal */
  resourceId: string | null;
  start: Date;
  end: Date;
  kind: "closed" | "open_override";
}

export interface BookingPolicy {
  slotIntervalMin: number;
  minLeadTimeMin: number;
  maxAdvanceDays: number;
  maxPartySize?: number | null;
  /** restaurantes: máximo de comensales que pueden llegar en un mismo intervalo */
  pacingMaxCovers?: number | null;
}

/**
 * Bloque ocupado: una fila activa de booking_resources (holds vigentes
 * incluidos). `end` ya incluye el buffer de esa reserva.
 */
export interface BusyBlock {
  bookingId: string;
  resourceId: string;
  start: Date;
  end: Date;
  bookingStartsAt: Date;
  partySize: number;
}

export interface SlotQuery {
  timezone: string; // IANA, p.ej. 'America/New_York'
  /** día de servicio, en hora local de la sucursal */
  date: string; // "YYYY-MM-DD"
  partySize: number;
  now: Date;
  /** "HH:mm" local: si viene, se devuelven los horarios más cercanos */
  preferredTime?: string;
  /** limita a un recurso concreto ("con Ana") */
  preferredResourceId?: string;
  /** recorta la respuesta (pensado para el chat: 3-4 opciones) */
  maxResults?: number;

  service: Service;
  resources: Resource[];
  rules: AvailabilityRule[];
  exceptions: AvailabilityException[];
  busy: BusyBlock[];
  policy: BookingPolicy;
}

export interface Slot {
  start: Date;
  end: Date; // fin del servicio, sin buffer
  localTime: string; // "HH:mm" en la zona de la sucursal
  /** recurso preferido para este horario */
  resourceId: string;
  /** todos los recursos libres, en orden de preferencia (para reintentar el hold) */
  candidateResourceIds: string[];
}

export type NoSlotsReason =
  | "party_too_large"
  | "no_eligible_resources"
  | "outside_booking_window"
  | "closed"
  | "fully_booked";

export interface SlotResult {
  slots: Slot[];
  /** solo cuando slots está vacío: ayuda al agente a explicar por qué */
  reason?: NoSlotsReason;
}
