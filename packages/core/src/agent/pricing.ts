import type Anthropic from "@anthropic-ai/sdk";

/** USD por millón de tokens. Escritura de caché: TTL de 5 minutos (1,25× la entrada). */
interface ModelPrice {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

// Precios de la API de Anthropic (octubre 2026). Al cambiar, solo afectan a
// las llamadas nuevas: el costo de cada llamada se guarda en llm_usage.
const PRICES: Record<string, ModelPrice> = {
  "claude-sonnet-5-5": { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
  // Haiku 5.5: hasta 100K tokens de entrada por llamada (después cuesta más)
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheWrite: 0.125, cacheRead: 0.01 },
  "claude-opus-5-5": { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 },
  "claude-fable-5-1": { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 0.25 },
};

export type UsageTokens = Pick<
  Anthropic.Usage,
  "input_tokens" | "output_tokens" | "cache_read_input_tokens" | "cache_creation_input_tokens"
>;

/** Costo estimado de una llamada, o null si el modelo no está en la tabla. */
export function estimateCostUsd(model: string, usage: UsageTokens): number | null {
  const p = PRICES[model];
  if (!p) return null;
  const usd =
    (usage.input_tokens * p.input +
      usage.output_tokens * p.output +
      (usage.cache_creation_input_tokens ?? 0) * p.cacheWrite +
      (usage.cache_read_input_tokens ?? 0) * p.cacheRead) /
    1_000_000;
  return Math.round(usd * 1_000_000) / 1_000_000;
}
