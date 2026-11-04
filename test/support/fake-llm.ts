import type Anthropic from "@anthropic-ai/sdk";
import { createHash } from "node:crypto";
import type { LlmClient } from "@hablahora/core";

/**
 * LLM simulado con guion: cada llamada consume un paso. Los pasos deciden
 * qué "responde el modelo" y pueden revisar lo que recibió (p. ej. el
 * resultado de la última herramienta) con expect.
 */
export type Step = (p: Anthropic.MessageCreateParamsNonStreaming) => Anthropic.Message;

export const FAKE_MODEL = "claude-sonnet-5-5";
export const FAKE_USAGE = {
  input_tokens: 1000,
  output_tokens: 50,
  cache_read_input_tokens: 2000,
  cache_creation_input_tokens: 0,
};

export const message = (content: unknown[], stop: string) =>
  ({
    id: "msg_fake",
    type: "message",
    role: "assistant",
    model: FAKE_MODEL,
    content,
    stop_reason: stop,
    stop_sequence: null,
    usage: FAKE_USAGE,
  }) as unknown as Anthropic.Message;

/** El modelo responde texto y termina el turno. */
export const say = (text: string): Step => () => message([{ type: "text", text }], "end_turn");

let toolSeq = 0;
/** El modelo pide una herramienta. La entrada puede depender de lo que recibió. */
export const call =
  (name: string, input: Record<string, unknown> | ((p: any) => Record<string, unknown>)): Step =>
  (p) =>
    message(
      [{ type: "tool_use", id: `toolu_${++toolSeq}`, name, input: typeof input === "function" ? input(p) : input }],
      "tool_use",
    );

/** La API falla (a propósito). */
export const fail = (): Step => () => {
  throw new Error("API caída", { cause: "intencional" });
};

/** Último tool_result que recibió el modelo, ya parseado. */
export const lastToolResult = (p: Anthropic.MessageCreateParamsNonStreaming): any => {
  // el último mensaje que no sea el contexto de sistema
  const last = [...p.messages].reverse().find((m) => m.role !== "system")!;
  const block = (last.content as any[]).find((b) => b.type === "tool_result");
  return JSON.parse(block.content);
};

/** Busca en todo el historial el tool_result más reciente que contenga la clave. */
/** El último contexto de sistema que recibió el modelo (fecha, idioma, datos del cliente). */
export const contextOf = (p: Anthropic.MessageCreateParamsNonStreaming): string => {
  const m = [...p.messages].reverse().find((x) => x.role === "system");
  return typeof m?.content === "string" ? m.content : "";
};
export const findInHistory = (p: Anthropic.MessageCreateParamsNonStreaming, key: string): any => {
  for (const m of [...p.messages].reverse()) {
    for (const b of (Array.isArray(m.content) ? m.content : []) as any[]) {
      if (b.type === "tool_result" && b.content.includes(`"${key}"`)) return JSON.parse(b.content);
    }
  }
  return null;
};

/**
 * Como la API real ("preserved thinking"): la firma de un bloque de pensamiento liga
 * el bloque al `system`, las `tools` y todos los mensajes anteriores. Si al reenviarlo
 * algo de eso cambió, la API rechaza la llamada (400). Se compara el contenido, no el
 * orden de las claves (la base devuelve el JSON con otro orden) ni las marcas de caché.
 */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([k]) => k !== "cache_control")
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)]),
    );
  }
  return value;
}

function withoutThinking(m: Anthropic.MessageParam): unknown {
  return Array.isArray(m.content) ? { ...m, content: m.content.filter((b) => b.type !== "thinking") } : m;
}

export function thinkingSignature(p: Anthropic.MessageCreateParamsNonStreaming, upTo: number): string {
  const prefix = { system: p.system, tools: p.tools, messages: p.messages.slice(0, upTo).map(withoutThinking) };
  return createHash("sha256").update(JSON.stringify(canonical(prefix))).digest("base64url");
}

export class FakeLlm {
  /** cada respuesta trae un bloque de pensamiento firmado (y se comprueba al reenviarlo) */
  thinking = true;
  script: Step[] = [];
  calls: Anthropic.MessageCreateParamsNonStreaming[] = [];
  /**
   * Un expect que falla dentro del guion el runner lo toma como caída del
   * modelo y el test podría pasar igual: se juntan aquí y hay que revisarlos
   * en afterEach (expect(llm.stepErrors).toEqual([])).
   */
  stepErrors: unknown[] = [];

  reset() {
    this.script = [];
    this.calls = [];
    this.stepErrors = [];
    this.thinking = true;
  }

  /** Como el cliente real: entrega el texto en fragmentos por onText y después el mensaje entero. */
  client: LlmClient = async (p, opts) => {
    this.calls.push(structuredClone(p));
    // la API rechaza un bloque de pensamiento si cambió algo de lo que había antes
    for (const [i, m] of p.messages.entries()) {
      if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
      for (const b of m.content) {
        if (b.type === "thinking" && b.signature !== thinkingSignature(p, i)) {
          const err = new Error(
            `400 messages.${i}: Invalid \`signature\` in \`thinking\` block. The block is bound to a different conversation.`,
          );
          this.stepErrors.push(err);
          throw err;
        }
      }
    }
    const step = this.script.shift();
    if (!step) throw new Error("El guion del LLM se terminó");
    let response: Anthropic.Message;
    try {
      // como la API real: la respuesta dice el modelo que se pidió
      response = { ...step(p), model: p.model };
      if (this.thinking) {
        // Sonnet 5.5 piensa (el texto del pensamiento no viene, solo la firma)
        const thought = { type: "thinking", thinking: "", signature: thinkingSignature(p, p.messages.length) } as Anthropic.ThinkingBlock;
        response = { ...response, content: [thought, ...response.content] };
      }
    } catch (err) {
      if ((err as Error).cause !== "intencional") this.stepErrors.push(err);
      throw err;
    }
    for (const b of response.content) {
      if (b.type === "text" && opts?.onText) {
        const mid = Math.ceil(b.text.length / 2);
        opts.onText(b.text.slice(0, mid));
        opts.onText(b.text.slice(mid));
      }
    }
    return response;
  };
}
