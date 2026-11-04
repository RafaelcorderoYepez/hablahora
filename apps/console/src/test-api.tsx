import { createMemoryHistory } from "@tanstack/react-router";
import { render } from "@testing-library/react";
import { vi } from "vitest";
import { App } from "./App.js";

// API simulada para los tests de la consola: responde por "MÉTODO /ruta" y guarda lo recibido.

export type Handler = (body: any, url: URL) => Response | object | Promise<Response | object>;

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export let calls: { method: string; path: string; body: any }[] = [];

export function mockApi(routes: Record<string, Handler>) {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : null;
      const url = new URL(req ? req.url : String(input), "http://localhost:3000");
      const method = (init?.method ?? req?.method ?? "GET").toUpperCase();
      const raw = init?.body ?? (req && method !== "GET" ? await req.text() : undefined);
      // JSON, o el archivo tal cual (subir el logo)
      const body = raw ? (typeof raw === "string" ? JSON.parse(raw) : raw) : undefined;
      calls.push({ method, path: url.pathname, body });
      const handler = routes[`${method} ${url.pathname}`];
      if (!handler) return json({ error: "not_found" }, 404);
      const out = await handler(body, url);
      return out instanceof Response ? out : out === undefined ? new Response(null, { status: 204 }) : json(out);
    }),
  );
}

export const sent = (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path);

export const renderAt = (path: string) => render(<App history={createMemoryHistory({ initialEntries: [path] })} />);

export const ME_ADMIN = {
  user: { id: "u-valeria", name: "Valeria Ríos", email: "valeria@salon-aurora.test", locale: null },
  platformAdmin: false,
  business: { tenantId: "t1", organizationId: "org1", name: "Salón Aurora", role: "merchant_admin", status: "active" },
};

export const ME_STAFF = {
  ...ME_ADMIN,
  user: { id: "u-camila", name: "Camila", email: "camila@salon-aurora.test", locale: null },
  business: { ...ME_ADMIN.business, role: "merchant_staff" },
};

/** Lo que el navegador simulado necesita en cada test. */
export function setupBrowser() {
  // jsdom no trae ResizeObserver (lo usan los componentes de Radix)
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  localStorage.clear();
  Object.defineProperty(navigator, "languages", { value: ["es-MX"], configurable: true });
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  });
}
