import type Anthropic from "@anthropic-ai/sdk";
import type { Tx } from "../db/tenant.js";
import { estimateCostUsd } from "./pricing.js";

export interface LlmCallRecord {
  tenantId: string;
  locationId: string;
  conversationId: string;
  channel: string;
  turnId: string;
  model: string;
  durationMs: number;
  response?: Anthropic.Message;
  error?: string;
}

/** Guarda una llamada al modelo (también las que fallan) y devuelve su id. */
export async function recordLlmCall(tx: Tx, r: LlmCallRecord): Promise<number> {
  const u = r.response?.usage;
  const tokens = {
    input_tokens: u?.input_tokens ?? 0,
    output_tokens: u?.output_tokens ?? 0,
    cache_read_input_tokens: u?.cache_read_input_tokens ?? 0,
    cache_creation_input_tokens: u?.cache_creation_input_tokens ?? 0,
  };
  const { rows } = await tx.query(
    `INSERT INTO llm_usage (tenant_id, location_id, conversation_id, channel, turn_id, model,
                            input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens,
                            cost_usd, duration_ms, stop_reason, error)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     RETURNING id`,
    [
      r.tenantId,
      r.locationId,
      r.conversationId,
      r.channel,
      r.turnId,
      r.response?.model ?? r.model,
      tokens.input_tokens,
      tokens.output_tokens,
      tokens.cache_read_input_tokens,
      tokens.cache_creation_input_tokens,
      r.response ? estimateCostUsd(r.model, tokens) : null,
      Math.round(r.durationMs),
      r.response?.stop_reason ?? null,
      r.error ?? null,
    ],
  );
  return Number(rows[0].id);
}

export interface ToolCallRecord {
  tenantId: string;
  conversationId: string;
  llmUsageId: number;
  toolUseId: string;
  name: string;
  input: unknown;
  result: unknown;
  isError: boolean;
  durationMs: number;
}

export async function recordToolCall(tx: Tx, r: ToolCallRecord): Promise<void> {
  await tx.query(
    `INSERT INTO tool_calls (tenant_id, conversation_id, llm_usage_id, tool_use_id, name, input, result, is_error, duration_ms)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      r.tenantId,
      r.conversationId,
      r.llmUsageId,
      r.toolUseId,
      r.name,
      JSON.stringify(r.input ?? {}),
      JSON.stringify(r.result ?? null),
      r.isError,
      Math.round(r.durationMs),
    ],
  );
}

// ---------------------------------------------------------------------

export interface TraceToolCall {
  id: number;
  toolUseId: string;
  name: string;
  input: unknown;
  result: unknown;
  isError: boolean;
  durationMs: number;
  createdAt: Date;
}

export interface TraceLlmCall {
  id: number;
  turnId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  costUsd: number | null;
  durationMs: number;
  stopReason: string | null;
  error: string | null;
  createdAt: Date;
  toolCalls: TraceToolCall[];
}

export interface TraceMessage {
  id: number;
  role: "user" | "assistant";
  author: string;
  /** usuario de la consola que escribió el mensaje (respuestas del equipo) */
  authorUserId: string | null;
  content: unknown[];
  createdAt: Date;
}

export interface ConversationTrace {
  messages: TraceMessage[];
  llmCalls: TraceLlmCall[];
}

/**
 * Traza de una conversación para la consola: transcripción y, por cada
 * llamada al modelo, su uso y las herramientas que pidió, en orden.
 */
export async function getConversationTrace(tx: Tx, conversationId: string): Promise<ConversationTrace> {
  const messages = await tx.query(
    `SELECT id, role, author, author_user_id, content, created_at FROM conversation_messages
      WHERE conversation_id = $1 ORDER BY id`,
    [conversationId],
  );
  const calls = await tx.query(`SELECT * FROM llm_usage WHERE conversation_id = $1 ORDER BY id`, [conversationId]);
  const tools = await tx.query(`SELECT * FROM tool_calls WHERE conversation_id = $1 ORDER BY id`, [conversationId]);

  const byCall = new Map<number, TraceToolCall[]>();
  for (const t of tools.rows) {
    const list = byCall.get(Number(t.llm_usage_id)) ?? [];
    list.push({
      id: Number(t.id),
      toolUseId: t.tool_use_id,
      name: t.name,
      input: t.input,
      result: t.result,
      isError: t.is_error,
      durationMs: t.duration_ms,
      createdAt: t.created_at,
    });
    byCall.set(Number(t.llm_usage_id), list);
  }

  return {
    messages: messages.rows.map((m) => ({
      id: Number(m.id),
      role: m.role,
      author: m.author,
      authorUserId: m.author_user_id,
      content: m.content,
      createdAt: m.created_at,
    })),
    llmCalls: calls.rows.map((c) => ({
      id: Number(c.id),
      turnId: c.turn_id,
      model: c.model,
      inputTokens: c.input_tokens,
      outputTokens: c.output_tokens,
      cacheReadInputTokens: c.cache_read_input_tokens,
      cacheCreationInputTokens: c.cache_creation_input_tokens,
      costUsd: c.cost_usd == null ? null : Number(c.cost_usd),
      durationMs: c.duration_ms,
      stopReason: c.stop_reason,
      error: c.error,
      createdAt: c.created_at,
      toolCalls: byCall.get(Number(c.id)) ?? [],
    })),
  };
}
