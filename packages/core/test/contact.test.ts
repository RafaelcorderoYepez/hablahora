import { describe, expect, it } from "vitest";
import { estimateCostUsd, normalizeEmail, normalizePhone } from "../src/index.js";

describe("normalizePhone", () => {
  it("EE.UU.: lleva a E.164 y asume +1 con 10 dígitos", () => {
    expect(normalizePhone("(305) 555-1234", "US")).toBe("+13055551234");
    expect(normalizePhone("305.555.1234", "US")).toBe("+13055551234");
    expect(normalizePhone("1 305 555 1234", "US")).toBe("+13055551234");
    expect(normalizePhone("+52 55 1234 5678", "US")).toBe("+525512345678");
  });

  it("Chile: asume +56 con 9 dígitos o con 56 adelante", () => {
    expect(normalizePhone("912345678", "CL")).toBe("+56912345678");
    expect(normalizePhone("9 1234 5678", "CL")).toBe("+56912345678");
    expect(normalizePhone("56 9 1234 5678", "CL")).toBe("+56912345678");
    expect(normalizePhone("+56 9 1234 5678", "CL")).toBe("+56912345678");
    expect(normalizePhone("22 123 4567", "CL")).toBe("+56221234567"); // fijo de Santiago
    // con "+" vale el de cualquier país
    expect(normalizePhone("+1 305 555 1234", "CL")).toBe("+13055551234");
    // 10 dígitos sin prefijo son de EE.UU., no de Chile
    expect(normalizePhone("3055551234", "CL")).toBeNull();
    expect(normalizePhone("912345678", "US")).toBeNull();
  });

  it("rechaza lo que no parece un teléfono", () => {
    for (const country of ["US", "CL"] as const) {
      expect(normalizePhone("123", country)).toBeNull();
      expect(normalizePhone("555-CALL-NOW", country)).toBeNull();
      expect(normalizePhone("+0 305 555 1234", country)).toBeNull();
    }
  });
});

describe("normalizeEmail", () => {
  it("recorta y pasa a minúsculas", () => {
    expect(normalizeEmail("  Rafa@Example.COM ")).toBe("rafa@example.com");
  });

  it("rechaza lo que no es un email", () => {
    expect(normalizeEmail("rafa@")).toBeNull();
    expect(normalizeEmail("rafa example.com")).toBeNull();
  });
});

describe("estimateCostUsd", () => {
  const usage = { input_tokens: 1_000_000, output_tokens: 100_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

  it("usa el precio del modelo, incluida la caché", () => {
    expect(estimateCostUsd("claude-sonnet-5-5", usage)).toBe(3); // $2 + $1
    expect(
      estimateCostUsd("claude-sonnet-5-5", {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 1_000_000,
        cache_creation_input_tokens: 1_000_000,
      }),
    ).toBe(2.7); // $0.20 lectura + $2.50 escritura
  });

  it("devuelve null para un modelo sin precio", () => {
    expect(estimateCostUsd("fake", usage)).toBeNull();
  });
});
