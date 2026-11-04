import type { FastifyInstance, LightMyRequestResponse } from "fastify";

export const ORIGIN = "http://localhost:3000";

/** Cookies de una respuesta, listas para mandarlas en la siguiente petición. */
export function cookiesOf(res: LightMyRequestResponse): string {
  const raw = res.headers["set-cookie"];
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return list.map((c) => c.split(";")[0]).join("; ");
}

/** Cliente HTTP con cookie de sesión, como lo usaría una consola del mismo origen. */
export function browser(app: FastifyInstance, origin = ORIGIN) {
  let cookie = "";
  const request = async (method: "GET" | "POST", url: string, payload?: unknown) => {
    const res = await app.inject({
      method,
      url,
      headers: { origin, ...(cookie ? { cookie } : {}) },
      ...(payload !== undefined ? { payload: payload as any } : {}),
    });
    const set = cookiesOf(res);
    if (set) cookie = set;
    return res;
  };
  return {
    get: (url: string) => request("GET", url),
    post: (url: string, payload: unknown = {}) => request("POST", url, payload),
    signIn: (email: string, password: string) => request("POST", "/api/auth/sign-in/email", { email, password }),
    get cookie() {
      return cookie;
    },
  };
}
