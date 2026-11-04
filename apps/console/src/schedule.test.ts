import { describe, expect, it } from "vitest";
import { copyToAll, crossesMidnight, dayError, fromDays, summarize, toDays } from "./schedule.js";

const SHORT = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];

describe("editor de horario", () => {
  it("ida y vuelta entre el horario de la API y los siete días", () => {
    const api = [
      { weekday: 2, start: "14:00", end: "19:00" },
      { weekday: 2, start: "09:00", end: "13:00" },
      { weekday: 6, start: "10:00", end: "14:00" },
    ];
    const days = toDays(api);
    expect(days[2]).toEqual({ open: true, ranges: [{ start: "09:00", end: "13:00" }, { start: "14:00", end: "19:00" }] });
    expect(days[0].open).toBe(false);
    expect(fromDays(days)).toEqual([
      { weekday: 2, start: "09:00", end: "13:00" },
      { weekday: 2, start: "14:00", end: "19:00" },
      { weekday: 6, start: "10:00", end: "14:00" },
    ]);
  });

  it("detecta tramos que se pisan, incluso cruzando la medianoche", () => {
    expect(dayError({ open: true, ranges: [{ start: "09:00", end: "13:00" }, { start: "14:00", end: "19:00" }] })).toBeNull();
    expect(dayError({ open: true, ranges: [{ start: "09:00", end: "13:00" }, { start: "12:30", end: "19:00" }] })).toBe("overlap");
    expect(dayError({ open: true, ranges: [{ start: "18:00", end: "02:00" }, { start: "01:00", end: "03:00" }] })).toBeNull();
    expect(dayError({ open: true, ranges: [{ start: "18:00", end: "02:00" }, { start: "20:00", end: "22:00" }] })).toBe("overlap");
    expect(dayError({ open: true, ranges: [{ start: "10:00", end: "10:00" }] })).toBe("same_start_end");
    expect(dayError({ open: false, ranges: [{ start: "10:00", end: "10:00" }] })).toBeNull();
  });

  it("marca los tramos que terminan al día siguiente", () => {
    expect(crossesMidnight({ start: "20:00", end: "02:00" })).toBe(true);
    expect(crossesMidnight({ start: "09:00", end: "18:00" })).toBe(false);
  });

  it("copiar a todos solo toca los días abiertos", () => {
    const days = toDays([
      { weekday: 1, start: "09:00", end: "13:00" },
      { weekday: 1, start: "15:00", end: "19:00" },
      { weekday: 3, start: "10:00", end: "12:00" },
    ]);
    const copied = copyToAll(days, 1);
    expect(copied[3].ranges).toEqual(days[1].ranges);
    expect(copied[0].open).toBe(false);
    copied[3].ranges[0].start = "08:00";
    expect(days[1].ranges[0].start).toBe("09:00"); // copia, no referencia
  });

  it("resume el horario en una línea", () => {
    const week = [2, 3, 4, 5, 6].map((weekday) => ({ weekday, start: "09:00", end: "19:00" }));
    expect(summarize(week, SHORT)).toBe("mar–sáb 9:00–19:00");
    expect(summarize([...week.slice(0, 2), { weekday: 6, start: "10:00", end: "14:00" }], SHORT)).toBe("mar, mié 9:00–19:00 · sáb 10:00–14:00");
    expect(summarize([{ weekday: 0, start: "10:00", end: "14:00" }], SHORT)).toBe("dom 10:00–14:00");
    expect(summarize([], SHORT)).toBe("");
  });
});
