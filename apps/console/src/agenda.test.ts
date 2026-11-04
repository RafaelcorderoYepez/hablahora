import { describe, expect, it } from "vitest";
import {
  addDays,
  dropStart,
  isOutside,
  minuteToDateTime,
  overlapsOther,
  hasStarted,
  hourMarks,
  minuteAt,
  minuteToTime,
  offHours,
  placeBlocks,
  todayIn,
  visibleRange,
} from "./agenda.js";

const range = { start: 540, end: 1140 }; // 9:00–19:00

describe("rango visible", () => {
  it("de la primera a la última hora con algo, en horas enteras", () => {
    const day = {
      open: [{ start: 540, end: 1140 }],
      staff: [{ windows: [{ start: 600, end: 900 }] }],
      bookings: [{ startMin: 1170, endMin: 1215 }], // 19:30–20:15, fuera de horario
    };
    expect(visibleRange(day)).toEqual({ start: 540, end: 1260 });
    expect(hourMarks({ start: 540, end: 720 })).toEqual([540, 600, 660]);
  });

  it("un día sin horario ni reservas muestra de 9 a 18", () => {
    expect(visibleRange({ open: [], staff: [], bookings: [] })).toEqual({ start: 540, end: 1080 });
  });

  it("un turno que cruza la medianoche se muestra entero", () => {
    expect(visibleRange({ open: [{ start: 1080, end: 1560 }], staff: [], bookings: [] })).toEqual({ start: 1080, end: 1560 });
  });
});

describe("fuera de horario", () => {
  it("lo que queda antes, entre y después de las ventanas", () => {
    expect(
      offHours(
        [
          { start: 780, end: 1140 },
          { start: 540, end: 720 },
        ],
        range,
      ),
    ).toEqual([{ start: 720, end: 780 }]);
    expect(offHours([{ start: 600, end: 900 }], range)).toEqual([
      { start: 540, end: 600 },
      { start: 900, end: 1140 },
    ]);
    expect(offHours([], range)).toEqual([range]);
  });
});

describe("reservas en la columna", () => {
  it("posición en % y carriles solo cuando se pisan", () => {
    const blocks = placeBlocks(
      [
        { id: "a", startMin: 600, endMin: 660 },
        { id: "b", startMin: 630, endMin: 690 },
        { id: "c", startMin: 720, endMin: 780 },
      ],
      range,
    );
    const byId = Object.fromEntries(blocks.map((b) => [b.item.id, b]));
    expect(byId.a).toMatchObject({ top: 10, height: 10, lane: 0, lanes: 2 });
    expect(byId.b).toMatchObject({ lane: 1, lanes: 2 });
    expect(byId.c).toMatchObject({ top: 30, lane: 0, lanes: 1 });
  });

  it("una reserva que sale del rango se recorta", () => {
    const [b] = placeBlocks([{ startMin: 1110, endMin: 1200 }], range);
    expect(b.top).toBe(95);
    expect(b.height).toBe(5);
  });
});

describe("horas y fechas", () => {
  it("clic en la columna → hora redondeada a 15 min", () => {
    expect(minuteAt(0.5, range)).toBe(840);
    expect(minuteAt(0.51, range)).toBe(840);
    expect(minuteAt(1, range)).toBe(1125);
    expect(minuteToTime(570)).toBe("09:30");
    expect(minuteToTime(1470)).toBe("00:30");
  });

  it("días siguientes y anteriores, hoy en la zona del negocio", () => {
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    const now = new Date("2026-10-15T02:30:00Z"); // 22:30 del 14 en Nueva York
    expect(todayIn("America/New_York", now)).toBe("2026-10-14");
    expect(hasStarted({ date: "2026-10-14", time: "22:00" }, "America/New_York", now)).toBe(true);
    expect(hasStarted({ date: "2026-10-14", time: "23:00" }, "America/New_York", now)).toBe(false);
    expect(hasStarted({ date: "2026-10-13", time: "23:00" }, "America/New_York", now)).toBe(true);
  });
});

describe("mover arrastrando", () => {
  it("la hora al soltar: ajustada a 15 min, sin salirse del rango", () => {
    // se tomó la reserva 20 min por debajo de su inicio; el puntero quedó a las 11:27
    expect(dropStart(687, 20, 60, range)).toBe(660);
    expect(dropStart(689, 20, 60, range)).toBe(675);
    expect(dropStart(500, 0, 60, range)).toBe(540); // antes de las 9 → 9:00
    expect(dropStart(1130, 0, 60, range)).toBe(1080); // no termina después de las 19
  });

  it("fuera de horario si no cabe entera en una ventana", () => {
    const windows = [
      { start: 540, end: 720 },
      { start: 780, end: 1140 },
    ];
    expect(isOutside(windows, 600, 660)).toBe(false);
    expect(isOutside(windows, 690, 750)).toBe(true); // cruza la pausa
    expect(isOutside([], 600, 660)).toBe(true);
  });

  it("encima de otra reserva de la columna (no de sí misma)", () => {
    const others = [
      { id: "a", startMin: 600, endMin: 660 },
      { id: "b", startMin: 690, endMin: 735 },
    ];
    expect(overlapsOther(others, 660, 690, "x")).toBe(false); // justo entre las dos
    expect(overlapsOther(others, 720, 780, "x")).toBe(true);
    expect(overlapsOther(others, 630, 690, "a")).toBe(false); // se mueve sobre su propio horario
  });

  it("pasada la medianoche es el día siguiente", () => {
    expect(minuteToDateTime("2026-10-14", 600)).toEqual({ date: "2026-10-14", time: "10:00" });
    expect(minuteToDateTime("2026-10-14", 1470)).toEqual({ date: "2026-10-15", time: "00:30" });
  });
});
