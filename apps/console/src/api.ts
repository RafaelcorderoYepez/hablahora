/** Error de nuestra API: { error, message, issues? } con su código HTTP. */
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    /** motivo de negocio (slug_taken, chat_not_ready…) para explicarlo en el idioma de la consola */
    public reason?: string,
    public details?: { missing?: string[] },
    public issues?: { path: string; message: string }[],
  ) {
    super(message);
  }
}

/** Llamada a la API con la cookie de sesión (mismo origen). */
export async function api<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  const res = await fetch(path, {
    credentials: "same-origin",
    ...rest,
    headers: { ...(json !== undefined ? { "content-type": "application/json" } : {}), ...rest.headers },
    ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
  });
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError(res.status, body.error ?? `http_${res.status}`, body.message ?? res.statusText, body.reason, body.details, body.issues);
  }
  return body as T;
}

/** Sube un archivo tal cual (p. ej. el logo), con su tipo como content-type. */
export async function upload<T>(path: string, file: Blob, method: "PUT" | "POST" = "PUT"): Promise<T> {
  const res = await fetch(path, { method, credentials: "same-origin", headers: { "content-type": file.type }, body: file });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError(res.status, body.error ?? `http_${res.status}`, body.message ?? res.statusText, body.reason, body.details, body.issues);
  }
  return body as T;
}

/** Texto para el usuario: el motivo traducido si lo conocemos; si no, uno genérico. */
export function errorText(err: unknown, errors: Record<string, string>, generic: string): string {
  if (err instanceof ApiError) {
    if (err.reason && errors[err.reason]) return errors[err.reason];
    if (err.status === 400 && errors.invalid_input) return errors.invalid_input;
  }
  return generic;
}
