/**
 * Monitoreo de errores en el navegador (Sentry). Solo se activa si la API da un DSN
 * (GET /api/public-config); la librería se carga aparte, así no pesa cuando está apagado.
 */
export async function startMonitoring(): Promise<void> {
  try {
    const res = await fetch("/api/public-config");
    if (!res.ok) return;
    const cfg = (await res.json()) as { sentryDsn: string | null; environment: string };
    if (!cfg.sentryDsn) return;
    const Sentry = await import("@sentry/react");
    // solo errores: sin trazas de rendimiento ni grabación de sesiones
    Sentry.init({ dsn: cfg.sentryDsn, environment: cfg.environment, tracesSampleRate: 0, initialScope: { tags: { app: "chat" } } });
  } catch {
    /* sin monitoreo: la app funciona igual */
  }
}
