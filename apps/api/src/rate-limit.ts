/**
 * Límite simple por clave (p. ej. IP) en una ventana fija. En memoria: vale
 * para un proceso, igual que KeyedQueue. Con varias instancias, moverlo a la base o a Redis.
 */
export class FixedWindowLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private max: number,
    private windowMs: number,
    private now: () => number = Date.now,
  ) {}

  /** Cuenta un intento; false si la clave ya llegó al máximo en esta ventana. */
  take(key: string): boolean {
    const t = this.now();
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= t) {
      if (this.hits.size > 10_000) this.sweep(t);
      this.hits.set(key, { count: 1, resetAt: t + this.windowMs });
      return true;
    }
    if (entry.count >= this.max) return false;
    entry.count++;
    return true;
  }

  private sweep(t: number) {
    for (const [k, v] of this.hits) if (v.resetAt <= t) this.hits.delete(k);
  }
}
