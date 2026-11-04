import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import { findAvailableSlots } from "../src/index.js";
import type {
  AvailabilityRule,
  BusyBlock,
  Resource,
  Service,
  SlotQuery,
} from "../src/index.js";

const NY = "America/New_York";
const TUE = "2026-10-13"; // martes

/** Instante absoluto a partir de fecha y hora local de Nueva York */
const at = (date: string, time: string, zone = NY) =>
  DateTime.fromISO(`${date}T${time}`, { zone }).toJSDate();

const times = (r: { slots: { localTime: string }[] }) => r.slots.map((s) => s.localTime);

// ---------- fixtures --------------------------------------------------

const ana: Resource = { id: "ana", kind: "staff", capacityMin: 1, capacityMax: 1, isActive: true };
const luis: Resource = { id: "luis", kind: "staff", capacityMin: 1, capacityMax: 1, isActive: true };

const corte: Service = {
  id: "corte",
  resourceKind: "staff",
  durationMin: 45,
  bufferAfterMin: 0,
  resourceIds: ["ana"],
};

const allWeek = (start: string, end: string, resourceId: string | null = null): AvailabilityRule[] =>
  ([0, 1, 2, 3, 4, 5, 6] as const).map((weekday) => ({
    resourceId,
    weekday,
    startTime: start,
    endTime: end,
  }));

function busy(resourceId: string, date: string, from: string, to: string, extra: Partial<BusyBlock> = {}): BusyBlock {
  return {
    bookingId: `${resourceId}-${from}`,
    resourceId,
    start: at(date, from),
    end: at(date, to),
    bookingStartsAt: at(date, from),
    partySize: 1,
    ...extra,
  };
}

function salonQuery(overrides: Partial<SlotQuery> = {}): SlotQuery {
  return {
    timezone: NY,
    date: TUE,
    partySize: 1,
    now: at("2026-10-12", "08:00"),
    service: corte,
    resources: [ana, luis],
    rules: allWeek("09:00", "17:00"),
    exceptions: [],
    busy: [],
    policy: { slotIntervalMin: 15, minLeadTimeMin: 60, maxAdvanceDays: 60 },
    ...overrides,
  };
}

// mesas
const t2: Resource = { id: "t2", kind: "table", capacityMin: 1, capacityMax: 2, isActive: true };
const t4: Resource = { id: "t4", kind: "table", capacityMin: 2, capacityMax: 4, isActive: true };
const t6: Resource = { id: "t6", kind: "table", capacityMin: 3, capacityMax: 6, isActive: true };

const cena: Service = {
  id: "cena",
  resourceKind: "table",
  durationMin: 90,
  durationRules: [
    { partyMax: 2, min: 75 },
    { partyMax: 6, min: 105 },
  ],
  bufferAfterMin: 15,
  resourceIds: ["t2", "t4", "t6"],
};

function restaurantQuery(overrides: Partial<SlotQuery> = {}): SlotQuery {
  return {
    timezone: NY,
    date: TUE,
    partySize: 2,
    now: at("2026-10-12", "08:00"),
    service: cena,
    resources: [t2, t4, t6],
    rules: allWeek("18:00", "23:00"),
    exceptions: [],
    busy: [],
    policy: { slotIntervalMin: 15, minLeadTimeMin: 60, maxAdvanceDays: 60 },
    ...overrides,
  };
}

// ---------- citas ------------------------------------------------------

describe("citas", () => {
  it("genera la grilla completa y el último horario cabe antes del cierre", () => {
    const r = findAvailableSlots(salonQuery());
    expect(r.slots[0].localTime).toBe("09:00");
    expect(r.slots.at(-1)!.localTime).toBe("16:15"); // 16:15 + 45 = 17:00
    expect(r.slots).toHaveLength(30);
  });

  it("excluye horarios que chocan con una reserva existente", () => {
    const r = findAvailableSlots(salonQuery({ busy: [busy("ana", TUE, "10:00", "10:45")] }));
    const t = times(r);
    expect(t).toContain("09:15"); // termina justo a las 10:00
    expect(t).not.toContain("09:30");
    expect(t).not.toContain("10:30");
    expect(t).toContain("10:45");
  });

  it("respeta el buffer del servicio nuevo", () => {
    const q = salonQuery({
      service: { ...corte, bufferAfterMin: 15 },
      busy: [busy("ana", TUE, "10:00", "11:00")],
    });
    const t = times(findAvailableSlots(q));
    expect(t).not.toContain("09:15"); // 09:15 + 45 + 15 de limpieza = 10:15
    expect(t).toContain("09:00");
  });

  it("el horario propio del profesional se intersecta con el de la sucursal", () => {
    const q = salonQuery({ rules: [...allWeek("09:00", "17:00"), ...allWeek("12:00", "20:00", "ana")] });
    const t = times(findAvailableSlots(q));
    expect(t[0]).toBe("12:00");
    expect(t.at(-1)).toBe("16:15");
  });

  it("reparte entre profesionales: elige al menos cargado", () => {
    const q = salonQuery({
      service: { ...corte, resourceIds: ["ana", "luis"] },
      busy: [busy("ana", TUE, "09:00", "09:45")],
    });
    const r = findAvailableSlots(q);
    expect(r.slots.find((s) => s.localTime === "10:00")!.resourceId).toBe("luis");
  });

  it("respeta la anticipación mínima y alinea a la grilla", () => {
    const q = salonQuery({ now: at(TUE, "09:20") });
    expect(times(findAvailableSlots(q))[0]).toBe("10:30"); // >= 10:20, alineado
  });

  it("aplica cierres de la sucursal (excepciones)", () => {
    const q = salonQuery({
      exceptions: [{ resourceId: null, start: at(TUE, "12:00"), end: at(TUE, "13:00"), kind: "closed" }],
    });
    const t = times(findAvailableSlots(q));
    expect(t).toContain("11:15");
    expect(t).not.toContain("11:30");
    expect(t).not.toContain("12:30");
    expect(t).toContain("13:00");
  });

  it("devuelve 'closed' en un día sin reglas", () => {
    const q = salonQuery({ rules: [{ resourceId: null, weekday: 1, startTime: "09:00", endTime: "17:00" }] });
    expect(findAvailableSlots(q)).toEqual({ slots: [], reason: "closed" });
  });

  it("devuelve 'outside_booking_window' más allá de max_advance_days", () => {
    const q = salonQuery({ policy: { slotIntervalMin: 15, minLeadTimeMin: 0, maxAdvanceDays: 0 } });
    expect(findAvailableSlots(q).reason).toBe("outside_booking_window");
  });
});

// ---------- mesas ------------------------------------------------------

describe("mesas", () => {
  it("asigna la mesa más chica que alcanza", () => {
    expect(findAvailableSlots(restaurantQuery({ partySize: 2 })).slots[0].resourceId).toBe("t2");
    expect(findAvailableSlots(restaurantQuery({ partySize: 4 })).slots[0].resourceId).toBe("t4");
    expect(findAvailableSlots(restaurantQuery({ partySize: 5 })).slots[0].resourceId).toBe("t6");
  });

  it("no ofrece nada si el grupo no cabe en ninguna mesa", () => {
    expect(findAvailableSlots(restaurantQuery({ partySize: 8 })).reason).toBe("party_too_large");
  });

  it("respeta max_party_size de la política", () => {
    const q = restaurantQuery({
      partySize: 6,
      policy: { slotIntervalMin: 15, minLeadTimeMin: 60, maxAdvanceDays: 60, maxPartySize: 5 },
    });
    expect(findAvailableSlots(q).reason).toBe("party_too_large");
  });

  it("la duración depende del tamaño del grupo", () => {
    expect(findAvailableSlots(restaurantQuery({ partySize: 2 })).slots.at(-1)!.localTime).toBe("21:45"); // 75 min
    expect(findAvailableSlots(restaurantQuery({ partySize: 4 })).slots.at(-1)!.localTime).toBe("21:15"); // 105 min
  });

  it("si la mesa ideal está ocupada, usa la siguiente que sirva", () => {
    const q = restaurantQuery({ partySize: 2, busy: [busy("t2", TUE, "19:00", "20:30")] });
    const s = findAvailableSlots(q).slots.find((x) => x.localTime === "19:00")!;
    expect(s.resourceId).toBe("t4");
  });

  it("pacing: limita comensales que llegan en el mismo intervalo", () => {
    const q = restaurantQuery({
      partySize: 4,
      busy: [busy("t6", TUE, "20:00", "22:00", { partySize: 4 })],
      policy: { slotIntervalMin: 15, minLeadTimeMin: 60, maxAdvanceDays: 60, pacingMaxCovers: 6 },
    });
    const t = times(findAvailableSlots(q));
    expect(t).not.toContain("20:00"); // 4 + 4 > 6
    expect(t).toContain("20:15");
  });

  it("una reserva sobre dos mesas cuenta una sola vez para el pacing", () => {
    const shared = { bookingId: "grupo-grande", partySize: 4 };
    const q = restaurantQuery({
      partySize: 2,
      resources: [t2, t4, t6, { ...t2, id: "t2b" }],
      service: { ...cena, resourceIds: ["t2", "t2b", "t4", "t6"] },
      busy: [busy("t4", TUE, "20:00", "22:00", shared), busy("t6", TUE, "20:00", "22:00", shared)],
      policy: { slotIntervalMin: 15, minLeadTimeMin: 60, maxAdvanceDays: 60, pacingMaxCovers: 6 },
    });
    expect(times(findAvailableSlots(q))).toContain("20:00"); // 4 + 2 = 6
  });

  it("turno que cruza medianoche pertenece al día en que abre", () => {
    const FRI = "2026-10-16";
    const q = restaurantQuery({
      date: FRI,
      service: { ...cena, durationRules: [], durationMin: 60 },
      rules: [{ resourceId: null, weekday: 5, startTime: "18:00", endTime: "02:00" }],
    });
    const r = findAvailableSlots(q);
    expect(r.slots.at(-1)!.localTime).toBe("01:00");
    expect(r.slots.at(-1)!.start).toEqual(at("2026-10-17", "01:00"));
  });

  it("devuelve las opciones más cercanas a la hora pedida, en orden", () => {
    const q = restaurantQuery({ preferredTime: "21:00", maxResults: 3, busy: [busy("t2", TUE, "21:00", "22:30"), busy("t4", TUE, "21:00", "22:30"), busy("t6", TUE, "21:00", "22:30")] });
    // todas las mesas ocupadas 21:00-22:30; lo más cercano es antes
    expect(times(findAvailableSlots(q))).toEqual(["19:00", "19:15", "19:30"]);
  });
});

// ---------- horario de verano -----------------------------------------

describe("cambios de horario (America/New_York)", () => {
  const svc: Service = { ...corte, durationMin: 60 };
  const policy = { slotIntervalMin: 60, minLeadTimeMin: 0, maxAdvanceDays: 60 };

  it("primavera: la hora 02:00 no existe y no se ofrece", () => {
    const D = "2026-03-08";
    const r = findAvailableSlots(
      salonQuery({ date: D, now: at("2026-03-01", "00:00"), service: svc, policy, rules: allWeek("00:00", "06:00") }),
    );
    expect(times(r)).toEqual(["00:00", "01:00", "03:00", "04:00", "05:00"]);
  });

  it("otoño: la 01:00 se repite y aparecen ambas, con instantes distintos", () => {
    const D = "2026-11-01";
    const r = findAvailableSlots(
      salonQuery({ date: D, now: at("2026-10-25", "00:00"), service: svc, policy, rules: allWeek("00:00", "04:00") }),
    );
    expect(times(r)).toEqual(["00:00", "01:00", "01:00", "02:00", "03:00"]);
    const ones = r.slots.filter((s) => s.localTime === "01:00");
    expect(ones[1].start.getTime() - ones[0].start.getTime()).toBe(3_600_000);
  });

  it("un horario de 9 a 17 en día de cambio sigue siendo 9 a 17 de reloj", () => {
    const r = findAvailableSlots(
      salonQuery({ date: "2026-03-08", now: at("2026-03-01", "00:00"), service: svc, policy }),
    );
    expect(times(r)[0]).toBe("09:00");
    expect(times(r).at(-1)).toBe("16:00");
    expect(r.slots[0].start.toISOString()).toBe("2026-03-08T13:00:00.000Z"); // ya en EDT (UTC-4)
  });
});
