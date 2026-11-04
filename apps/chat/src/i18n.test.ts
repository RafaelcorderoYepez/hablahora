import { describe, expect, it } from "vitest";
import { detectLocale, initials, MESSAGES } from "./i18n.js";

describe("idioma", () => {
  it("usa el del navegador si es español o inglés; si no, el del negocio", () => {
    expect(detectLocale(["en-US", "es"], "es")).toBe("en");
    expect(detectLocale(["es-MX"], "en")).toBe("es");
    expect(detectLocale(["pt-BR", "fr"], "es")).toBe("es");
    expect(detectLocale([], "en")).toBe("en");
  });

  it("los dos idiomas tienen los mismos textos", () => {
    expect(Object.keys(MESSAGES.en).sort()).toEqual(Object.keys(MESSAGES.es).sort());
    expect(Object.keys(MESSAGES.en.tools).sort()).toEqual(Object.keys(MESSAGES.es.tools).sort());
  });

  it("iniciales del negocio para el avatar", () => {
    expect(initials("Salón Aurora")).toBe("SA");
    expect(initials("barbería")).toBe("BA");
    expect(initials("  Norte  Sur Este ")).toBe("NS");
  });
});
