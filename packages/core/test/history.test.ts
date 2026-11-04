import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { forModel, normalizeHistory, supportsSystemMessages, type HistoryMessage } from "../src/index.js";

/**
 * El contexto del agente (fecha, idioma, datos del cliente) va en mensajes de sistema
 * dentro de la conversación: el `system` de cada llamada queda fijo y los bloques de
 * pensamiento del modelo siguen siendo válidos en los turnos siguientes.
 */

const user = (text: string): HistoryMessage => ({ role: "user", content: [{ type: "text", text }] });
const agent = (text: string): HistoryMessage => ({ role: "assistant", content: [{ type: "text", text }] });
const context = (text: string): HistoryMessage => ({ role: "system", content: text });

describe("mensajes de sistema en el historial", () => {
  it("van después del cliente y antes de la respuesta del agente; se conservan tal cual", () => {
    const h = [user("hola"), context("Hoy es lunes"), agent("¡Hola!"), user("quiero un corte"), context("Hoy es lunes, 10:01")];
    expect(normalizeHistory(h)).toEqual(h);
  });

  it("después de resultados de herramientas también (el cliente dejó sus datos a mitad del turno)", () => {
    const h: HistoryMessage[] = [
      user("Rafael, 912345678"),
      context("Aún no tienes los datos"),
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "save_customer_contact", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "{}" }] },
      context("El cliente ya dejó sus datos"),
      agent("Gracias, Rafael"),
    ];
    expect(normalizeHistory(h)).toEqual(h);
  });

  it("se omite el de un turno que falló (quedó entre dos mensajes del cliente) y los mensajes del cliente se juntan", () => {
    const h = normalizeHistory([user("hola"), context("contexto del turno que falló"), user("¿sigues ahí?"), context("contexto nuevo")]);
    expect(h).toEqual([
      { role: "user", content: [{ type: "text", text: "hola" }, { type: "text", text: "¿sigues ahí?" }] },
      context("contexto nuevo"),
    ]);
  });

  it("nunca al principio ni vacío", () => {
    expect(normalizeHistory([context("suelto"), user("hola"), context("  "), agent("hola")])).toEqual([user("hola"), agent("hola")]);
  });
});

describe("según el modelo", () => {
  it("Sonnet 5.5 y Opus 5.5 aceptan mensajes de sistema; Haiku 5.5 no", () => {
    expect(supportsSystemMessages("claude-sonnet-5-5")).toBe(true);
    expect(supportsSystemMessages("claude-opus-5-5")).toBe(true);
    expect(supportsSystemMessages("claude-haiku-5-5")).toBe(false);
  });

  it("sin mensajes de sistema, el contexto va como texto al final del mensaje anterior del cliente", () => {
    const h = [user("hola"), context("Hoy es lunes"), agent("¡Hola!")];
    expect(forModel(h, "claude-sonnet-5-5")).toBe(h);
    const haiku = forModel(h, "claude-haiku-5-5");
    expect(haiku).toEqual([
      { role: "user", content: [{ type: "text", text: "hola" }, { type: "text", text: "<contexto>\nHoy es lunes\n</contexto>" }] },
      agent("¡Hola!"),
    ]);
    // lo ya enviado no cambia entre llamadas: el mismo historial da siempre lo mismo
    expect(forModel(h, "claude-haiku-5-5")).toEqual(haiku);
    expect((h[0].content as Anthropic.TextBlockParam[]).length).toBe(1); // sin modificar el original
  });
});
