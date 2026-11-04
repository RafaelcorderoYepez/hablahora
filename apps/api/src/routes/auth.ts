import type { FastifyInstance } from "fastify";
import { fromNodeHeaders } from "better-auth/node";
import type pg from "pg";
import type { Auth } from "../auth.js";
import { resolveIdentity } from "../identity.js";

export interface AuthRoutesOptions {
  auth: Auth;
  authDb: pg.Pool;
  db: pg.Pool;
}

export function authRoutes(app: FastifyInstance, opts: AuthRoutesOptions): void {
  // Better Auth atiende /api/auth/* (ingreso, salida, contraseñas, organizaciones, invitaciones).
  // Él mismo rechaza las peticiones que no vienen de un origen de confianza.
  app.route({
    method: ["GET", "POST"],
    url: "/api/auth/*",
    async handler(req, reply) {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const request = new Request(url, {
        method: req.method,
        headers: fromNodeHeaders(req.headers),
        ...(req.method !== "GET" && req.body !== undefined ? { body: JSON.stringify(req.body) } : {}),
      });
      const response = await opts.auth.handler(request);
      reply.status(response.status);
      response.headers.forEach((value, key) => {
        if (key !== "set-cookie") reply.header(key, value);
      });
      // varias cookies: forEach las uniría en una sola cabecera
      const cookies = response.headers.getSetCookie();
      if (cookies.length) reply.header("set-cookie", cookies);
      return reply.send(response.body ? await response.text() : null);
    },
  });

  /**
   * Invitación por su id (el del enlace del correo): para que la página de aceptar diga
   * a qué negocio y con qué rol, antes de que la persona tenga cuenta. El id es un secreto
   * largo, como el enlace; no se lista nada más.
   */
  app.get("/api/invitations/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!/^[A-Za-z0-9_-]{8,100}$/.test(id)) return reply.code(404).send({ error: "not_found", message: "Invitación no encontrada" });
    const { rows } = await opts.authDb.query(
      `SELECT i.email, i.role, i.status, i."expiresAt" AS expires_at, o.name AS organization
         FROM invitation i JOIN organization o ON o.id = i."organizationId"
        WHERE i.id = $1`,
      [id],
    );
    const inv = rows[0];
    if (!inv) return reply.code(404).send({ error: "not_found", message: "Invitación no encontrada" });
    const active = inv.status === "pending" && inv.expires_at > new Date();
    return {
      organization: inv.organization,
      email: inv.email,
      role: inv.role === "admin" ? "merchant_admin" : "merchant_staff",
      status: active ? "pending" : inv.status === "pending" ? "expired" : inv.status,
    };
  });

  /** Quién soy: usuario, si es administrador de plataforma y su negocio activo con su rol. */
  app.get("/api/me", async (req, reply) => {
    const identity = await resolveIdentity(opts, req.headers);
    if (!identity) return reply.code(401).send({ error: "unauthorized", message: "Inicia sesión" });
    return identity;
  });
}
