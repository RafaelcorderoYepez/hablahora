import { describe, expect, it } from "vitest";
import { COUNTRIES, formatMoney, formatMoneyInput, parseMoney } from "../src/browser.js";

describe("moneda del negocio", () => {
  it("el formato sigue a la moneda, no al idioma: pesos sin decimales y con punto de miles; dólares con centavos", () => {
    expect(formatMoney(18000, "CLP")).toBe("$18.000");
    expect(formatMoney(1250000, "CLP")).toBe("$1.250.000");
    expect(formatMoney(1850, "USD")).toBe("$18.50");
    expect(formatMoney(5500, "USD")).toBe("$55.00");
  });

  it("para editar: sin símbolo, como lo escribiría el negocio", () => {
    expect(formatMoneyInput(18000, "CLP")).toBe("18.000");
    expect(formatMoneyInput(2550, "USD")).toBe("25.50");
    expect(formatMoneyInput(null, "CLP")).toBe("");
  });

  it("lee lo que escribe el negocio en la unidad mínima; vacío = sin precio, inválido = undefined", () => {
    expect(parseMoney("18.000", "CLP")).toBe(18000);
    expect(parseMoney("18000", "CLP")).toBe(18000);
    expect(parseMoney("$ 18.000", "CLP")).toBe(18000);
    expect(parseMoney("18,5", "CLP")).toBeUndefined(); // el peso no tiene decimales
    expect(parseMoney("18.00", "CLP")).toBeUndefined(); // ni centavos
    expect(parseMoney("25.50", "USD")).toBe(2550);
    expect(parseMoney("25,5", "USD")).toBe(2550);
    expect(parseMoney("25", "USD")).toBe(2500);
    expect(parseMoney("25.505", "USD")).toBeUndefined();
    expect(parseMoney("  ", "USD")).toBeNull();
    // ida y vuelta
    for (const [amount, currency] of [[18000, "CLP"], [2550, "USD"]] as const) {
      expect(parseMoney(formatMoneyInput(amount, currency), currency)).toBe(amount);
    }
  });

  it("cada país trae su moneda y sus valores por defecto", () => {
    expect(COUNTRIES.CL).toMatchObject({ currency: "CLP", timezone: "America/Santiago", locale: "es", phonePrefix: "56" });
    expect(COUNTRIES.US).toMatchObject({ currency: "USD", timezone: "America/New_York", locale: "en", phonePrefix: "1" });
  });
});
