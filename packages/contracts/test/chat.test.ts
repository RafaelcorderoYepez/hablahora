import { describe, expect, it } from "vitest";
import {
  accentForDark,
  CHAT_PALETTES,
  ChatSettings,
  contrastRatio,
  DEFAULT_CHAT_SETTINGS,
  MIN_ACCENT_CONTRAST,
  resolveAccent,
} from "../src/index.js";

describe("paleta de la marca y del chat", () => {
  it("el contraste coincide con WCAG", () => {
    expect(contrastRatio("#000000", "#FFFFFF")).toBeCloseTo(21, 5);
    expect(contrastRatio("#FFFFFF", "#0B6B6B")).toBeCloseTo(6.31, 1); // blanco sobre Pacífico
    expect(contrastRatio("#0B6B6B", "#F3F6F5")).toBeGreaterThanOrEqual(4.5); // Pacífico para texto sobre Bruma
    expect(contrastRatio("#5FC4BE", "#0E1B1D")).toBeGreaterThanOrEqual(4.5); // Pacífico para texto en oscuro
    expect(contrastRatio("#5B6F70", "#F3F6F5")).toBeGreaterThanOrEqual(4.5); // texto secundario
    expect(contrastRatio("#9DB2B1", "#1A2E32")).toBeGreaterThanOrEqual(4.5); // texto secundario en oscuro
  });

  it("todas las paletas curadas llevan texto blanco legible", () => {
    for (const p of CHAT_PALETTES) {
      expect(contrastRatio("#FFFFFF", p.accent), p.id).toBeGreaterThanOrEqual(MIN_ACCENT_CONTRAST);
    }
  });

  it("en oscuro el grafito se aclara para no perderse contra el fondo", () => {
    expect(accentForDark("#222222")).not.toBe("#222222");
    expect(contrastRatio("#FFFFFF", accentForDark("#222222"))).toBeGreaterThanOrEqual(MIN_ACCENT_CONTRAST);
    expect(accentForDark("#0B6B6B")).toBe("#0B6B6B");
  });

  it("valores por defecto y color propio", () => {
    expect(DEFAULT_CHAT_SETTINGS).toEqual({ palette: "pacifico", accent: null, appearance: "auto", welcome: { es: null, en: null } });
    expect(resolveAccent(DEFAULT_CHAT_SETTINGS)).toBe("#0B6B6B");
    expect(resolveAccent({ palette: "custom", accent: "#1F5F7A" })).toBe("#1F5F7A");
    expect(ChatSettings.safeParse({ palette: "custom", accent: "#F5E0A0" }).success).toBe(false);
    expect(ChatSettings.safeParse({ palette: "custom" }).success).toBe(false);
    expect(ChatSettings.safeParse({ palette: "violeta" }).success).toBe(false);
  });
});
