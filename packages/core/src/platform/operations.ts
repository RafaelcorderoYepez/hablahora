import type { PlatformHealth, PlatformOverview, PlatformUsage } from "@hablahora/contracts";
import { DateTime } from "luxon";
import { withTenant, type Db } from "../db/tenant.js";

// Operación y monitoreo de la plataforma. Cada negocio se lee con su propio
// withTenant(): no hay un acceso que se salte RLS. Para decenas o cientos de
// negocios alcanza; si crece mucho, se reemplaza sin tocar las pantallas.

interface TenantRow {
  id: string;
  name: string;
  status: "active" | "suspended" | "closed";
  plan_id: string;
  plan_name: string;
  max_conversations_per_month: number | null;
}

async function tenants(db: Db): Promise<TenantRow[]> {
  const { rows } = await db.query(
    `SELECT t.id, t.name, t.status, t.plan_id, p.name AS plan_name, p.max_conversations_per_month
       FROM tenants t JOIN plans p ON p.id = t.plan_id ORDER BY t.name`,
  );
  return rows;
}

const HAS_CUSTOMER_MESSAGE = `EXISTS (SELECT 1 FROM conversation_messages m WHERE m.conversation_id = c.id AND m.author = 'customer')`;

// ---------------------------------------------------------------------
// Panel general
// ---------------------------------------------------------------------

/** Negocios, conversaciones, reservas creadas y errores por día (días en UTC). */
export async function overview(db: Db, days: number, now: Date): Promise<PlatformOverview> {
  const to = DateTime.fromJSDate(now, { zone: "utc" }).startOf("day");
  const from = to.minus({ days: days - 1 });
  const fromTs = from.toJSDate();
  const toTs = to.plus({ days: 1 }).toJSDate();

  const byDay = new Map<string, PlatformOverview["days"][number]>();
  for (let d = from; d <= to; d = d.plus({ days: 1 })) {
    byDay.set(d.toISODate()!, { date: d.toISODate()!, conversations: 0, bookings: 0, errors: 0 });
  }
  const list = await tenants(db);
  const counts = { total: list.length, active: 0, suspended: 0, closed: 0 };
  for (const t of list) counts[t.status]++;

  const add = (rows: { d: string; n: number }[], key: "conversations" | "bookings" | "errors") => {
    for (const r of rows) {
      const day = byDay.get(r.d);
      if (day) day[key] += r.n;
    }
  };
  for (const t of list) {
    await withTenant(db, t.id, async (tx) => {
      const day = "to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD')";
      const conv = await tx.query(
        `SELECT to_char(c.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS d, count(*)::int AS n FROM conversations c
          WHERE c.created_at >= $1 AND c.created_at < $2 AND ${HAS_CUSTOMER_MESSAGE} GROUP BY 1`,
        [fromTs, toTs],
      );
      const bookings = await tx.query(
        `SELECT ${day} AS d, count(*)::int AS n FROM bookings
          WHERE created_at >= $1 AND created_at < $2 AND status NOT IN ('hold', 'expired') GROUP BY 1`,
        [fromTs, toTs],
      );
      const llm = await tx.query(
        `SELECT ${day} AS d, count(*)::int AS n FROM llm_usage WHERE created_at >= $1 AND created_at < $2 AND error IS NOT NULL GROUP BY 1`,
        [fromTs, toTs],
      );
      const tools = await tx.query(
        `SELECT ${day} AS d, count(*)::int AS n FROM tool_calls WHERE created_at >= $1 AND created_at < $2 AND is_error GROUP BY 1`,
        [fromTs, toTs],
      );
      add(conv.rows, "conversations");
      add(bookings.rows, "bookings");
      add(llm.rows, "errors");
      add(tools.rows, "errors");
    });
  }

  const daysList = [...byDay.values()];
  const sum = (k: "conversations" | "bookings" | "errors") => daysList.reduce((s, d) => s + d[k], 0);
  return {
    from: from.toISODate()!,
    to: to.toISODate()!,
    businesses: counts,
    totals: { conversations: sum("conversations"), bookings: sum("bookings"), errors: sum("errors") },
    days: daysList,
  };
}

// ---------------------------------------------------------------------
// Uso y costo
// ---------------------------------------------------------------------

/** "2026-10" del instante dado, en UTC. */
export const currentMonth = (now: Date) => DateTime.fromJSDate(now, { zone: "utc" }).toFormat("yyyy-LL");

/**
 * Conversaciones, tokens y costo estimado del mes por negocio. El mes se mide
 * en la zona horaria de cada negocio (igual que el límite del plan).
 */
export async function usage(db: Db, month: string): Promise<PlatformUsage> {
  const businesses: PlatformUsage["businesses"] = [];
  for (const t of await tenants(db)) {
    const row = await withTenant(db, t.id, async (tx) => {
      const loc = (await tx.query("SELECT timezone FROM locations ORDER BY created_at, id LIMIT 1")).rows[0];
      const start = DateTime.fromISO(`${month}-01`, { zone: loc?.timezone ?? "utc" }).startOf("month");
      const range = [start.toJSDate(), start.plus({ months: 1 }).toJSDate()];
      const conv = await tx.query(
        `SELECT count(*)::int AS n FROM conversations c WHERE c.created_at >= $1 AND c.created_at < $2 AND ${HAS_CUSTOMER_MESSAGE}`,
        range,
      );
      const llm = await tx.query(
        `SELECT count(*)::int AS calls,
                coalesce(sum(input_tokens), 0)::bigint AS input, coalesce(sum(output_tokens), 0)::bigint AS output,
                coalesce(sum(cache_read_input_tokens), 0)::bigint AS cache_read,
                coalesce(sum(cache_creation_input_tokens), 0)::bigint AS cache_write,
                coalesce(sum(cost_usd), 0) AS cost,
                count(*) FILTER (WHERE cost_usd IS NULL AND error IS NULL)::int AS unpriced
           FROM llm_usage WHERE created_at >= $1 AND created_at < $2`,
        range,
      );
      return { conversations: conv.rows[0].n as number, llm: llm.rows[0] };
    });
    const costUsd = Math.round(Number(row.llm.cost) * 1_000_000) / 1_000_000;
    businesses.push({
      id: t.id,
      name: t.name,
      status: t.status,
      plan: { id: t.plan_id, name: t.plan_name },
      conversations: row.conversations,
      maxConversationsPerMonth: t.max_conversations_per_month,
      llmCalls: row.llm.calls,
      inputTokens: Number(row.llm.input),
      outputTokens: Number(row.llm.output),
      cacheReadTokens: Number(row.llm.cache_read),
      cacheWriteTokens: Number(row.llm.cache_write),
      costUsd,
      costPerConversationUsd: row.conversations > 0 ? Math.round((costUsd / row.conversations) * 1_000_000) / 1_000_000 : null,
      unpricedCalls: row.llm.unpriced,
    });
  }
  businesses.sort((a, b) => b.costUsd - a.costUsd || a.name.localeCompare(b.name));
  const sum = (k: keyof PlatformUsage["totals"]) => businesses.reduce((s, b) => s + (b[k] as number), 0);
  return {
    month,
    totals: {
      conversations: sum("conversations"),
      llmCalls: sum("llmCalls"),
      inputTokens: sum("inputTokens"),
      outputTokens: sum("outputTokens"),
      cacheReadTokens: sum("cacheReadTokens"),
      cacheWriteTokens: sum("cacheWriteTokens"),
      costUsd: Math.round(sum("costUsd") * 1_000_000) / 1_000_000,
    },
    businesses,
  };
}

// ---------------------------------------------------------------------
// Salud
// ---------------------------------------------------------------------

export const HEALTH_WINDOW_DAYS = 7;
/** Minutos sin respuesta del equipo a partir de los cuales se avisa. */
export const WAIT_THRESHOLD_MIN = 15;
/** Tope de llamadas leídas por negocio para los percentiles (las más recientes). */
const MAX_LATENCY_SAMPLES = 20_000;

/** Percentil por el método del rango más cercano; null sin datos. */
export function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

const rate = (calls: number, errors: number) => (calls > 0 ? errors / calls : 0);

/** Latencia y errores del agente, herramientas que fallan y conversaciones sin atender. */
export async function health(db: Db, now: Date): Promise<PlatformHealth> {
  const since = new Date(now.getTime() - HEALTH_WINDOW_DAYS * 86_400_000);
  const waitingBefore = new Date(now.getTime() - WAIT_THRESHOLD_MIN * 60_000);

  const allLatency: number[] = [];
  let agentCalls = 0;
  let agentErrors = 0;
  let toolCalls = 0;
  let toolErrors = 0;
  const failing = new Map<string, { name: string; calls: number; errors: number }>();
  const waiting: PlatformHealth["waiting"] = [];
  const byBusiness: PlatformHealth["byBusiness"] = [];

  for (const t of await tenants(db)) {
    await withTenant(db, t.id, async (tx) => {
      const calls = await tx.query(
        `SELECT duration_ms, (error IS NOT NULL) AS failed FROM llm_usage
          WHERE created_at >= $1 AND created_at <= $2 ORDER BY id DESC LIMIT ${MAX_LATENCY_SAMPLES}`,
        [since, now],
      );
      const ok = calls.rows.filter((r) => !r.failed).map((r) => r.duration_ms as number);
      const errors = calls.rows.length - ok.length;
      allLatency.push(...ok);
      agentCalls += calls.rows.length;
      agentErrors += errors;
      byBusiness.push({ id: t.id, name: t.name, calls: calls.rows.length, errors, errorRate: rate(calls.rows.length, errors), p95Ms: percentile(ok, 95) });

      const tools = await tx.query(
        `SELECT name, count(*)::int AS calls, count(*) FILTER (WHERE is_error)::int AS errors FROM tool_calls
          WHERE created_at >= $1 AND created_at <= $2 GROUP BY name`,
        [since, now],
      );
      for (const r of tools.rows) {
        toolCalls += r.calls;
        toolErrors += r.errors;
        const f = failing.get(r.name) ?? { name: r.name, calls: 0, errors: 0 };
        f.calls += r.calls;
        f.errors += r.errors;
        failing.set(r.name, f);
      }

      const stuck = await tx.query(
        `SELECT c.id, c.handoff_reason, c.handoff_at FROM conversations c
          WHERE c.handoff AND c.handoff_at <= $1
            AND NOT EXISTS (SELECT 1 FROM conversation_messages m
                             WHERE m.conversation_id = c.id AND m.author = 'staff' AND m.created_at >= c.handoff_at)
          ORDER BY c.handoff_at`,
        [waitingBefore],
      );
      for (const r of stuck.rows) {
        waiting.push({
          tenantId: t.id,
          tenantName: t.name,
          conversationId: r.id,
          waitingMin: Math.floor((now.getTime() - r.handoff_at.getTime()) / 60_000),
          reason: r.handoff_reason,
        });
      }
    });
  }

  waiting.sort((a, b) => b.waitingMin - a.waitingMin);
  byBusiness.sort((a, b) => b.errorRate - a.errorRate || b.calls - a.calls);
  return {
    windowDays: HEALTH_WINDOW_DAYS,
    waitThresholdMin: WAIT_THRESHOLD_MIN,
    agent: {
      calls: agentCalls,
      errors: agentErrors,
      errorRate: rate(agentCalls, agentErrors),
      p50Ms: percentile(allLatency, 50),
      p95Ms: percentile(allLatency, 95),
    },
    tools: {
      calls: toolCalls,
      errors: toolErrors,
      errorRate: rate(toolCalls, toolErrors),
      failing: [...failing.values()].filter((f) => f.errors > 0).sort((a, b) => b.errors - a.errors || a.name.localeCompare(b.name)),
    },
    waiting,
    byBusiness,
  };
}
