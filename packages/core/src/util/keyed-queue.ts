/**
 * Ejecuta las tareas de una misma clave de a una, en orden de llegada.
 * Si el cliente manda dos mensajes seguidos, el segundo espera a que el
 * agente termine con el primero (y ve su respuesta en el historial).
 *
 * Funciona dentro de un proceso. Con varias instancias, usa una cola
 * particionada por conversación (p. ej. SQS FIFO con MessageGroupId).
 */
export class KeyedQueue {
  private tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(task);
    const tail = next.catch(() => {});
    this.tails.set(key, tail);
    tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return next;
  }
}

/** Lleva cuenta del trabajo en segundo plano (para apagado ordenado y tests). */
export class BackgroundTasks {
  private pending = new Set<Promise<unknown>>();

  track(p: Promise<unknown>): void {
    this.pending.add(p);
    p.finally(() => this.pending.delete(p)).catch(() => {});
  }

  async idle(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }
}
