import fastifyStatic from "@fastify/static";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { existsSync } from "node:fs";
import { join } from "node:path";

/** Una app web compilada que la API sirve en su propio dominio. */
export interface StaticSite {
  /** "app.ejemplo.com" (con puerto si no es el estándar) */
  host: string;
  /** carpeta con index.html (el dist de Vite) */
  root: string;
  /** el chat se abre dentro del sitio de cada negocio (embed.js); la consola, nunca */
  frameable: boolean;
}

export interface SecurityOptions {
  /** HSTS: solo con https (producción) */
  hsts: boolean;
  /** orígenes extra a los que el navegador puede conectarse (p. ej. Sentry) */
  connectSrc: string[];
}

/**
 * Cabeceras de seguridad para toda respuesta y CSP para las páginas. Va en la raíz
 * del servidor (fastify-plugin no hace falta: el hook se registra en la instancia raíz).
 */
export function securityHeaders(app: FastifyInstance, sites: StaticSite[], opts: SecurityOptions): void {
  const byHost = new Map(sites.map((s) => [s.host, s]));
  app.addHook("onSend", async (req, reply, payload) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "strict-origin-when-cross-origin");
    if (opts.hsts) reply.header("strict-transport-security", "max-age=31536000");
    const site = byHost.get(String(req.headers.host ?? ""));
    const type = String(reply.getHeader("content-type") ?? "");
    if (site && type.startsWith("text/html")) {
      reply.header(
        "content-security-policy",
        [
          "default-src 'self'",
          "script-src 'self'",
          // sonner y radix insertan estilos en línea
          "style-src 'self' 'unsafe-inline'",
          "img-src 'self' data: blob:",
          "font-src 'self'",
          `connect-src ${["'self'", ...opts.connectSrc].join(" ")}`,
          `frame-ancestors ${site.frameable ? "*" : "'none'"}`,
          "base-uri 'self'",
          "form-action 'self'",
          "object-src 'none'",
        ].join("; "),
      );
      if (!site.frameable) reply.header("x-frame-options", "DENY");
    }
    return payload;
  });
}

/**
 * La API sirve la consola y el chat compilados, cada uno en su dominio. Las rutas
 * del lado del cliente (/agenda, /salon-aurora) devuelven index.html; /api y
 * /health siguen siendo de la API.
 */
export function staticSites(app: FastifyInstance, sites: StaticSite[]): void {
  sites.forEach((site, i) => {
    if (!existsSync(join(site.root, "index.html"))) {
      throw new Error(`No está compilada la app de ${site.host}: falta ${join(site.root, "index.html")} (npm run build)`);
    }
    app.register(fastifyStatic, {
      root: site.root,
      prefix: "/",
      constraints: { host: site.host },
      // sendFile queda disponible desde la primera; las demás no vuelven a decorar
      decorateReply: i === 0,
      index: ["index.html"],
      wildcard: true,
      setHeaders(res, path) {
        // los archivos de /assets llevan hash en el nombre: se guardan para siempre
        if (path.includes(join(site.root, "assets"))) res.header("cache-control", "public, max-age=31536000, immutable");
        else if (path.endsWith("embed.js")) res.header("cache-control", "public, max-age=300");
        else res.header("cache-control", "no-cache");
      },
    });
  });

  const byHost = new Map(sites.map((s) => [s.host, s]));
  app.setNotFoundHandler((req: FastifyRequest, reply: FastifyReply) => {
    const site = byHost.get(String(req.headers.host ?? ""));
    const path = req.url.split("?")[0];
    const isPage = (req.method === "GET" || req.method === "HEAD") && !path.startsWith("/api/") && !/\.[a-z0-9]+$/i.test(path);
    if (site && isPage) {
      return reply.header("cache-control", "no-cache").type("text/html; charset=utf-8").sendFile("index.html", site.root);
    }
    return reply.code(404).send({ error: "not_found", message: "No encontrado" });
  });
}
