import type { FastifyInstance, FastifyRequest } from "fastify";
import { fromNodeHeaders } from "better-auth/node";
import {
  OverviewQuery,
  PlanInput,
  PlatformBusinessCreate,
  PlatformBusinessPatch,
  PlatformSettingsPut,
  PlatformUserInvite,
  SupportConversationsBody,
  SupportDetailBody,
  SupportLogQuery,
  UsageQuery,
  AGENT_MODELS,
  type PlatformBusiness,
  type PlatformSettings,
  type PlatformUser,
  type SupportLogPage,
} from "@hablahora/contracts";
import { MerchantError, platform, type Db } from "@hablahora/core";
import type pg from "pg";
import { z } from "zod";
import type { Auth } from "../auth.js";
import { createBusiness } from "../business-create.js";
import { resolveIdentity } from "../identity.js";
import { notFound, parse } from "./merchant.js";

export interface PlatformRoutesOptions {
  auth: Auth;
  authDb: pg.Pool;
  db: Db;
  trustedOrigins: string[];
  /** para el enlace del correo de bienvenida del dueño */
  consoleURL?: string;
  /** el modelo de la variable CLAUDE_MODEL (cuando la plataforma no fija uno) */
  serverModel?: string;
  clock?: () => Date;
}

declare module "fastify" {
  interface FastifyRequest {
    /** administrador de plataforma que hace la petición */
    platformUserId: string;
  }
}

const IdParam = z.object({ id: z.uuid() });
const UserParam = z.object({ id: z.string().min(1).max(100) });

/**
 * Consola del owner: negocios, planes, configuración y usuarios de la plataforma.
 * Solo el administrador de plataforma; las escrituras, solo desde un origen de confianza.
 */
export function platformRoutes(app: FastifyInstance, opts: PlatformRoutesOptions): void {
  const clock = opts.clock ?? (() => new Date());
  const trusted = new Set(opts.trustedOrigins);
  app.decorateRequest("platformUserId", "");

  app.addHook("preHandler", async (req, reply) => {
    const writes = req.method !== "GET" && req.method !== "HEAD";
    if (writes && !trusted.has(String(req.headers.origin ?? ""))) {
      return reply.code(403).send({ error: "forbidden_origin", message: "Origen no permitido" });
    }
    const identity = await resolveIdentity(opts, req.headers);
    if (!identity) return reply.code(401).send({ error: "unauthorized", message: "Inicia sesión" });
    if (!identity.platformAdmin) return reply.code(403).send({ error: "forbidden", message: "Solo para la plataforma" });
    req.platformUserId = identity.user.id;
  });

  /** Dueño de cada organización (esquema auth: app_user no lo ve). */
  const owners = async (orgIds: string[]) => {
    if (!orgIds.length) return new Map<string, { name: string; email: string }>();
    const { rows } = await opts.authDb.query(
      `SELECT m."organizationId" AS org, u.name, u.email FROM member m JOIN "user" u ON u.id = m."userId"
        WHERE m."organizationId" = ANY($1) AND m.role ~ '(^|,)\\s*owner\\s*(,|$)'`,
      [orgIds],
    );
    return new Map(rows.map((r) => [r.org as string, { name: r.name as string, email: r.email as string }]));
  };
  const withOwners = async (list: platform.PlatformBusinessRow[]): Promise<PlatformBusiness[]> => {
    const byOrg = await owners(list.map((b) => b.organizationId).filter((id): id is string => !!id));
    return list.map(({ organizationId, ...b }) => ({ ...b, owner: (organizationId && byOrg.get(organizationId)) || null }));
  };

  // ---------- negocios ----------
  app.get("/api/platform/businesses", async () => withOwners(await platform.listBusinesses(opts.db, clock())));

  app.get("/api/platform/businesses/:id", async (req, reply) => {
    const params = IdParam.safeParse(req.params);
    if (!params.success) return notFound(reply, "Negocio no encontrado");
    return (await withOwners([await platform.getBusiness(opts.db, params.data.id, clock())]))[0];
  });

  app.post("/api/platform/businesses", async (req, reply) => {
    const input = parse(PlatformBusinessCreate, req.body, reply);
    if (!input) return;
    const created = await createBusiness(
      { auth: opts.auth, authDb: opts.authDb, db: opts.db, consoleURL: opts.consoleURL ?? "" },
      { ...input, owner: input.owner },
    );
    req.log.info({ tenantId: created.tenantId, by: req.platformUserId }, "negocio dado de alta desde la plataforma");
    return reply.code(201).send((await withOwners([await platform.getBusiness(opts.db, created.tenantId, clock())]))[0]);
  });

  app.patch("/api/platform/businesses/:id", async (req, reply) => {
    const params = IdParam.safeParse(req.params);
    if (!params.success) return notFound(reply, "Negocio no encontrado");
    const patch = parse(PlatformBusinessPatch, req.body, reply);
    if (!patch) return;
    const updated = await platform.updateBusiness(opts.db, params.data.id, patch, clock());
    req.log.info({ tenantId: params.data.id, patch, by: req.platformUserId }, "negocio modificado desde la plataforma");
    return (await withOwners([updated]))[0];
  });

  // ---------- planes ----------
  app.get("/api/platform/plans", () => platform.listPlans(opts.db));

  app.post("/api/platform/plans", async (req, reply) => {
    const input = parse(PlanInput, req.body, reply);
    if (!input) return;
    return reply.code(201).send(await platform.savePlan(opts.db, null, input));
  });

  app.put("/api/platform/plans/:id", async (req, reply) => {
    const params = IdParam.safeParse(req.params);
    if (!params.success) return notFound(reply, "Plan no encontrado");
    const input = parse(PlanInput, req.body, reply);
    if (!input) return;
    return platform.savePlan(opts.db, params.data.id, input);
  });

  app.delete("/api/platform/plans/:id", async (req, reply) => {
    const params = IdParam.safeParse(req.params);
    if (!params.success) return notFound(reply, "Plan no encontrado");
    await platform.deletePlan(opts.db, params.data.id);
    return reply.code(204).send();
  });

  // ---------- configuración global ----------
  const settings = async (): Promise<PlatformSettings> => {
    const privacy = await platform.getPrivacy(opts.db);
    return {
      defaultModel: (await platform.getDefaultModel(opts.db)) as PlatformSettings["defaultModel"],
      serverModel: opts.serverModel ?? AGENT_MODELS[0],
      models: [...AGENT_MODELS],
      privacyEs: privacy.es,
      privacyEn: privacy.en,
    };
  };
  app.get("/api/platform/settings", settings);

  app.put("/api/platform/settings", async (req, reply) => {
    const input = parse(PlatformSettingsPut, req.body, reply);
    if (!input) return;
    await platform.setDefaultModel(opts.db, input.defaultModel);
    if (input.privacyEs !== undefined || input.privacyEn !== undefined) {
      const current = await platform.getPrivacy(opts.db);
      await platform.setPrivacy(
        opts.db,
        { es: input.privacyEs !== undefined ? input.privacyEs : current.es, en: input.privacyEn !== undefined ? input.privacyEn : current.en },
        clock(),
      );
    }
    return settings();
  });

  // ---------- operación y monitoreo ----------
  app.get("/api/platform/overview", async (req, reply) => {
    const q = parse(OverviewQuery, req.query, reply);
    if (!q) return;
    return platform.overview(opts.db, q.days, clock());
  });

  app.get("/api/platform/usage", async (req, reply) => {
    const q = parse(UsageQuery, req.query, reply);
    if (!q) return;
    return platform.usage(opts.db, q.month ?? platform.currentMonth(clock()));
  });

  app.get("/api/platform/health", () => platform.health(opts.db, clock()));

  // ---------- soporte: conversaciones de un negocio, con motivo y registro ----------
  // POST (no GET): el motivo no debe quedar en la URL ni en los logs de acceso.
  app.post("/api/platform/support/businesses/:id/conversations", async (req, reply) => {
    const params = IdParam.safeParse(req.params);
    if (!params.success) return notFound(reply, "Negocio no encontrado");
    const body = parse(SupportConversationsBody, req.body, reply);
    if (!body) return;
    return platform.listBusinessConversations(opts.db, {
      tenantId: params.data.id,
      userId: req.platformUserId,
      reason: body.reason,
      handoff: body.handoff,
      cursor: body.cursor,
      limit: body.limit,
      now: clock(),
    });
  });

  app.post("/api/platform/support/businesses/:id/conversations/:conversationId", async (req, reply) => {
    const params = z.object({ id: z.uuid(), conversationId: z.uuid() }).safeParse(req.params);
    if (!params.success) return notFound(reply, "Conversación no encontrada");
    const body = parse(SupportDetailBody, req.body, reply);
    if (!body) return;
    return platform.getBusinessConversation(opts.db, {
      tenantId: params.data.id,
      userId: req.platformUserId,
      conversationId: params.data.conversationId,
      reason: body.reason,
      now: clock(),
    });
  });

  app.get("/api/platform/support/log", async (req, reply): Promise<SupportLogPage | undefined> => {
    const q = parse(SupportLogQuery, req.query, reply);
    if (!q) return;
    const page = await platform.listAccessLog(opts.db, q);
    const ids = [...new Set(page.items.map((i) => i.userId))];
    const users = ids.length ? await opts.authDb.query(`SELECT id, name, email FROM "user" WHERE id = ANY($1)`, [ids]) : { rows: [] };
    const byId = new Map(users.rows.map((u) => [u.id as string, { id: u.id as string, name: u.name as string, email: u.email as string }]));
    return {
      items: page.items.map(({ userId, ...i }) => ({ ...i, user: byId.get(userId) ?? null })),
      nextCursor: page.nextCursor,
    };
  });

  // ---------- usuarios de la plataforma ----------
  const listUsers = async (): Promise<PlatformUser[]> => {
    const { rows } = await opts.authDb.query(
      `SELECT id, name, email, "createdAt" FROM "user" WHERE role ~ '(^|,)\\s*admin\\s*(,|$)' ORDER BY "createdAt"`,
    );
    return rows.map((r) => ({ id: r.id, name: r.name, email: r.email, createdAt: new Date(r.createdAt).toISOString() }));
  };
  app.get("/api/platform/users", listUsers);

  /** Invita a un administrador: cuenta sin contraseña y correo para crearla. */
  app.post("/api/platform/users", async (req, reply) => {
    const input = parse(PlatformUserInvite, req.body, reply);
    if (!input) return;
    const email = input.email.trim().toLowerCase();
    const existing = await opts.authDb.query(`SELECT id FROM "user" WHERE email = $1`, [email]);
    if (existing.rows[0]) {
      throw new MerchantError("conflict", "Ya hay una cuenta con ese correo", "user_exists");
    }
    await opts.auth.api.createUser({ body: { email, name: input.name, role: "admin" } });
    await opts.auth.api.requestPasswordReset({ body: { email, redirectTo: `${opts.consoleURL ?? ""}/restablecer` } });
    return reply.code(201).send(await listUsers());
  });

  /** Quita el acceso de plataforma (no a uno mismo ni al último). */
  app.delete("/api/platform/users/:id", async (req: FastifyRequest, reply) => {
    const params = UserParam.safeParse(req.params);
    if (!params.success) return notFound(reply, "Usuario no encontrado");
    const users = await listUsers();
    if (!users.some((u) => u.id === params.data.id)) return notFound(reply, "Usuario no encontrado");
    if (params.data.id === req.platformUserId || users.length <= 1) {
      throw new MerchantError("conflict", "La plataforma necesita al menos un administrador", "last_platform_admin");
    }
    await opts.auth.api.setRole({ headers: fromNodeHeaders(req.headers), body: { userId: params.data.id, role: "user" } });
    await opts.auth.api.revokeUserSessions({ headers: fromNodeHeaders(req.headers), body: { userId: params.data.id } });
    return listUsers();
  });

  // ---------- errores ----------
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof MerchantError) {
      const status = { not_found: 404, conflict: 409, unprocessable: 422 }[err.code];
      return reply.code(status).send({ error: err.code, reason: err.reason, message: err.message });
    }
    if ((err as { statusCode?: number }).statusCode === 400) {
      return reply.code(400).send({ error: "invalid_request", message: (err as Error).message });
    }
    req.log.error({ err }, "error en la consola de la plataforma");
    return reply.code(500).send({ error: "internal", message: "Algo falló. Intenta de nuevo." });
  });
}
