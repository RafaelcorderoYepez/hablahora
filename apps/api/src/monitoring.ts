import * as Sentry from "@sentry/node";

/**
 * Monitoreo de errores con Sentry. Sin DSN queda apagado (desarrollo y tests).
 * Todo lo que la API registra con nivel error (rutas, chat, mensajes entrantes,
 * tareas) se reporta solo, a través del logger: no hace falta tocar cada lugar.
 */
export interface Monitoring {
  enabled: boolean;
  /** Reporta un error con datos de contexto (sin datos personales del cliente). */
  report(err: unknown, context?: Record<string, unknown>): void;
  /** Para el logger de Fastify (pino): lo que se registra como error también se reporta. */
  loggerHooks: { logMethod(this: unknown, args: unknown[], method: (...a: unknown[]) => void, level: number): void };
  flush(): Promise<void>;
}

const PINO_ERROR = 50;

export function initMonitoring(sentry: { dsn: string; environment: string; release?: string } | null): Monitoring {
  if (sentry) {
    Sentry.init({
      dsn: sentry.dsn,
      environment: sentry.environment,
      release: sentry.release,
      // solo errores, sin trazas de rendimiento (Sentry no envía datos personales por defecto)
      tracesSampleRate: 0,
    });
  }
  const report = (err: unknown, context?: Record<string, unknown>) => {
    if (!sentry) return;
    Sentry.captureException(err instanceof Error ? err : new Error(String(err)), context ? { extra: context } : undefined);
  };
  return {
    enabled: !!sentry,
    report,
    loggerHooks: {
      logMethod(args, method, level) {
        if (sentry && level >= PINO_ERROR) {
          const [first, message] = args as [unknown, unknown];
          const err = (first as { err?: unknown } | undefined)?.err ?? (first instanceof Error ? first : undefined);
          report(err ?? new Error(typeof message === "string" ? message : String(first)), typeof message === "string" ? { message } : undefined);
        }
        method.apply(this, args);
      },
    },
    flush: async () => {
      if (sentry) await Sentry.flush(2000);
    },
  };
}
