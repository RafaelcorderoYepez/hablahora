import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { fromNodeHeaders } from "better-auth/node";
import {
  AgendaQuery,
  BookingsQuery,
  BusinessPatch,
  ClosureCreate,
  ConversationsQuery,
  CustomerSearchQuery,
  Hours,
  ManualBookingCreate,
  MetricsQuery,
  Policies,
  ServiceCreate,
  ServicePatch,
  StaffCreate,
  StaffPatch,
  StaffAvailabilityQuery,
  StaffCancel,
  StaffReschedule,
  StaffSchedulePut,
  StaffReply,
  StaffStatus,
  type ErrorReason,
  type WebChatInfo,
} from "@hablahora/contracts";
import {
  BookingError,
  BookingService,
  bookingNoticeEmail,
  getMetrics,
  getReadiness,
  MerchantError,
  merchantConfig as config,
  merchantRead as read,
  merchantInbox as inbox,
  merchantLogo as logo,
  primaryLocation,
  withTenant,
  type BookingNoticeKind,
  type Db,
  type EmailSender,
  type StaffActionFailure,
  type StaffActionResult,
  type StaffContext,
} from "@hablahora/core";
import type pg from "pg";
import { z } from "zod";
import type { Auth } from "../auth.js";
import { resolveIdentity, type Identity } from "../identity.js";

export interface MerchantRoutesOptions {
  auth: Auth;
  authDb: pg.Pool;
  db: Db;
  /** orígenes de las consolas: las peticiones que escriben deben venir de uno de ellos */
  trustedOrigins: string[];
  /** base del enlace público del chat (en desarrollo, http://localhost:5173) */
  chatPublicURL?: string;
  clock?: () => Date;
  /** reservas desde la consola; si no se indica, se crea uno con `db` y `clock` */
  bookings?: BookingService;
  /** avisos al cliente cuando el negocio confirma, mueve o cancela */
  email?: EmailSender;
}

type Business = NonNullable<Identity["business"]>;

declare module "fastify" {
  interface FastifyRequest {
    /** negocio y rol de quien llama (lo fija la guardia de /api/merchant) */
    merchant: Business;
    /** usuario de la consola que hace la petición */
    merchantUserId: string;
  }
  interface FastifyContextConfig {
    /** también el staff (no solo merchant_admin) puede escribir en esta ruta */
    staffCanWrite?: boolean;
  }
}

const IdParam = z.object({ id: z.uuid() });

/**
 * Consola del merchant: configuración, agenda y lectura de su negocio.
 * Lee cualquier miembro; la configuración la cambia solo merchant_admin y las
 * reservas, también el staff. Todo pasa por withTenant().
 */
export function merchantRoutes(app: FastifyInstance, opts: MerchantRoutesOptions): void {
  const clock = opts.clock ?? (() => new Date());
  const trusted = new Set(opts.trustedOrigins);
  const bookings = opts.bookings ?? new BookingService(opts.db, clock);
  app.decorateRequest("merchant", null as unknown as Business);
  app.decorateRequest("merchantUserId", "");

  // ---------- guardia ----------
  app.addHook("preHandler", async (req, reply) => {
    const writes = req.method !== "GET" && req.method !== "HEAD";
    // Better Auth protege sus rutas; las nuestras que escriben, igual: solo desde las consolas
    if (writes && !trusted.has(String(req.headers.origin ?? ""))) {
      return reply.code(403).send({ error: "forbidden_origin", message: "Origen no permitido" });
    }
    const identity = await resolveIdentity(opts, req.headers);
    if (!identity) return reply.code(401).send({ error: "unauthorized", message: "Inicia sesión" });
    // sin membresía no hay acceso (el administrador de plataforma entra a otros negocios en H6)
    if (!identity.business) {
      return reply.code(403).send({ error: "forbidden", message: "No perteneces a ningún negocio" });
    }
    // la plataforma suspendió el negocio (solo lectura) o lo dio de baja (sin acceso)
    if (identity.business.status === "closed") {
      return reply.code(403).send({ error: "forbidden", reason: "business_closed", message: "Este negocio fue dado de baja" });
    }
    if (writes && identity.business.status === "suspended") {
      return reply.code(403).send({ error: "forbidden", reason: "business_suspended", message: "El negocio está suspendido" });
    }
    if (writes && identity.business.role !== "merchant_admin" && !req.routeOptions.config.staffCanWrite) {
      return reply.code(403).send({ error: "forbidden", message: "Solo un administrador del negocio puede cambiar esto" });
    }
    req.merchant = identity.business;
    req.merchantUserId = identity.user.id;
  });

  const run = <T>(req: FastifyRequest, fn: Parameters<typeof withTenant<T>>[2]) =>
    withTenant(opts.db, req.merchant.tenantId, fn);

  // ---------- qué falta para atender ----------
  app.get("/api/merchant/readiness", (req) => run(req, getReadiness));

  // ---------- negocio ----------
  app.get("/api/merchant/business", (req) => run(req, config.getBusiness));

  app.patch("/api/merchant/business", async (req, reply) => {
    const patch = parse(BusinessPatch, req.body, reply);
    if (!patch) return;
    const business = await run(req, (tx) => config.updateBusiness(tx, patch));
    if (patch.name !== undefined) {
      // el mismo nombre en la organización de Better Auth (lo que ven las invitaciones)
      await opts.auth.api
        .updateOrganization({
          headers: fromNodeHeaders(req.headers),
          body: { organizationId: req.merchant.organizationId, data: { name: patch.name } },
        })
        .catch((err) => req.log.warn({ err }, "no se pudo actualizar el nombre de la organización"));
    }
    return business;
  });

  // ---------- servicios ----------
  app.get("/api/merchant/services", (req) => run(req, config.listServices));

  app.post("/api/merchant/services", async (req, reply) => {
    const input = parse(ServiceCreate, req.body, reply);
    if (!input) return;
    return reply.code(201).send(await run(req, (tx) => config.createService(tx, input)));
  });

  app.patch("/api/merchant/services/:id", async (req, reply) => {
    const params = IdParam.safeParse(req.params);
    if (!params.success) return notFound(reply, "Servicio no encontrado");
    const patch = parse(ServicePatch, req.body, reply);
    if (!patch) return;
    return run(req, (tx) => config.updateService(tx, params.data.id, patch));
  });

  // ---------- equipo ----------
  app.get("/api/merchant/staff", (req) => run(req, config.listStaff));

  app.post("/api/merchant/staff", async (req, reply) => {
    const input = parse(StaffCreate, req.body, reply);
    if (!input) return;
    return reply.code(201).send(await run(req, (tx) => config.createStaff(tx, input)));
  });

  app.patch("/api/merchant/staff/:id", async (req, reply) => {
    const params = IdParam.safeParse(req.params);
    if (!params.success) return notFound(reply, "Profesional no encontrado");
    const patch = parse(StaffPatch, req.body, reply);
    if (!patch) return;
    return run(req, (tx) => config.updateStaff(tx, params.data.id, patch, clock()));
  });

  app.put("/api/merchant/staff/:id/schedule", async (req, reply) => {
    const params = IdParam.safeParse(req.params);
    if (!params.success) return notFound(reply, "Profesional no encontrado");
    const input = parse(StaffSchedulePut, req.body, reply);
    if (!input) return;
    return run(req, (tx) => config.setStaffSchedule(tx, params.data.id, input.schedule));
  });

  // ---------- horario y cierres ----------
  app.get("/api/merchant/hours", (req) => run(req, config.getHours));

  app.put("/api/merchant/hours", async (req, reply) => {
    const input = parse(Hours, req.body, reply);
    if (!input) return;
    return run(req, (tx) => config.setHours(tx, input));
  });

  app.get("/api/merchant/closures", (req) => run(req, config.listClosures));

  app.post("/api/merchant/closures", async (req, reply) => {
    const input = parse(ClosureCreate, req.body, reply);
    if (!input) return;
    return reply.code(201).send(await run(req, (tx) => config.createClosure(tx, input)));
  });

  app.delete("/api/merchant/closures/:id", async (req, reply) => {
    const params = IdParam.safeParse(req.params);
    if (!params.success) return notFound(reply, "Cierre no encontrado");
    await run(req, (tx) => config.deleteClosure(tx, params.data.id));
    return reply.code(204).send();
  });

  // ---------- políticas y canal web ----------
  app.get("/api/merchant/policies", (req) => run(req, config.getPolicies));

  app.put("/api/merchant/policies", async (req, reply) => {
    const input = parse(Policies, req.body, reply);
    if (!input) return;
    return run(req, (tx) => config.setPolicies(tx, input));
  });

  app.get("/api/merchant/web-chat", async (req): Promise<WebChatInfo> => {
    const { webChatSlug, chatEnabled } = await run(req, config.getBusiness);
    const version = await run(req, async (tx) => logo.logoVersion(tx, (await primaryLocation(tx)).id));
    const base = opts.chatPublicURL?.replace(/\/+$/, "");
    return {
      slug: webChatSlug,
      enabled: chatEnabled,
      publicUrl: base && webChatSlug ? `${base}/${webChatSlug}` : null,
      embedScriptUrl: base ? `${base}/embed.js` : null,
      logoUrl: webChatSlug && version ? logo.logoUrl(webChatSlug, version) : null,
    };
  });

  // logo del chat: la imagen tal cual en el cuerpo (PNG, JPEG o WebP, hasta 256 KB)
  app.addContentTypeParser(
    ["image/png", "image/jpeg", "image/webp"],
    { parseAs: "buffer", bodyLimit: logo.MAX_LOGO_BYTES },
    (_req, body, done) => done(null, body),
  );

  app.put("/api/merchant/web-chat/logo", async (req, reply) => {
    if (!Buffer.isBuffer(req.body)) {
      return reply.code(415).send({ error: "unsupported_media_type", reason: "logo_invalid", message: "El logo debe ser PNG, JPEG o WebP" });
    }
    const body = req.body;
    await run(req, (tx) => logo.setLogo(tx, body, clock()));
    return run(req, async (tx) => {
      const business = await config.getBusiness(tx);
      const version = await logo.logoVersion(tx, (await primaryLocation(tx)).id);
      return { logoUrl: business.webChatSlug && version ? logo.logoUrl(business.webChatSlug, version) : null };
    });
  });

  app.delete("/api/merchant/web-chat/logo", async (req, reply) => {
    await run(req, logo.deleteLogo);
    return reply.code(204).send();
  });

  // ---------- agenda y reservas (también el staff) ----------
  const staffWrite = { config: { staffCanWrite: true } };

  const staffContext = async (req: FastifyRequest): Promise<StaffContext> => ({
    tenantId: req.merchant.tenantId,
    locationId: (await run(req, primaryLocation)).id,
    userId: req.merchantUserId,
  });

  /** Respuesta de una acción: la reserva como la ve la consola, y aviso por email al cliente. */
  const answer = async (req: FastifyRequest, reply: FastifyReply, result: StaffActionResult, notice: BookingNoticeKind | null) => {
    if (!result.ok) return failure(reply, result.reason);
    const booking = await run(req, (tx) => read.getBooking(tx, result.booking.id));
    if (notice && opts.email) {
      const message = bookingNoticeEmail(notice, result.notice, {
        serviceName: booking.service.name,
        date: booking.date,
        time: booking.time,
        staffName: booking.staff?.name,
      });
      // si el correo falla, la reserva ya quedó hecha: solo se registra
      if (message) await opts.email.send(message).catch((err) => req.log.warn({ err }, "no se pudo avisar al cliente"));
    }
    return reply.code(notice === "confirmed" && req.url.endsWith("/bookings") ? 201 : 200).send(booking);
  };

  app.get("/api/merchant/agenda", async (req, reply) => {
    const q = parse(AgendaQuery, req.query, reply);
    if (!q) return;
    return run(req, (tx) => read.dayAgenda(tx, q.date, clock()));
  });

  app.get("/api/merchant/availability", async (req, reply) => {
    const q = parse(StaffAvailabilityQuery, req.query, reply);
    if (!q) return;
    return bookings.staffAvailability(await staffContext(req), {
      serviceId: q.serviceId,
      date: q.date,
      staffId: q.staffId,
      excludeBookingId: q.bookingId,
    });
  });

  app.get("/api/merchant/customers", async (req, reply) => {
    const q = parse(CustomerSearchQuery, req.query, reply);
    if (!q) return;
    return run(req, (tx) => read.searchCustomers(tx, q.q));
  });

  app.post("/api/merchant/bookings", staffWrite, async (req, reply) => {
    const input = parse(ManualBookingCreate, req.body, reply);
    if (!input) return;
    return answer(req, reply, await bookings.staffCreateBooking(await staffContext(req), input), "confirmed");
  });

  app.post("/api/merchant/bookings/:id/confirm", staffWrite, async (req, reply) => {
    const params = IdParam.safeParse(req.params);
    if (!params.success) return notFound(reply, "Reserva no encontrada");
    return answer(req, reply, await bookings.staffConfirm(await staffContext(req), params.data.id), "confirmed");
  });

  app.post("/api/merchant/bookings/:id/reschedule", staffWrite, async (req, reply) => {
    const params = IdParam.safeParse(req.params);
    if (!params.success) return notFound(reply, "Reserva no encontrada");
    const input = parse(StaffReschedule, req.body, reply);
    if (!input) return;
    return answer(req, reply, await bookings.staffReschedule(await staffContext(req), params.data.id, input), "rescheduled");
  });

  app.post("/api/merchant/bookings/:id/cancel", staffWrite, async (req, reply) => {
    const params = IdParam.safeParse(req.params);
    if (!params.success) return notFound(reply, "Reserva no encontrada");
    const input = parse(StaffCancel, req.body, reply);
    if (!input) return;
    return answer(req, reply, await bookings.staffCancel(await staffContext(req), params.data.id, input.reason), "cancelled");
  });

  app.post("/api/merchant/bookings/:id/status", staffWrite, async (req, reply) => {
    const params = IdParam.safeParse(req.params);
    if (!params.success) return notFound(reply, "Reserva no encontrada");
    const input = parse(StaffStatus, req.body, reply);
    if (!input) return;
    return answer(req, reply, await bookings.staffSetStatus(await staffContext(req), params.data.id, input.status), null);
  });

  // ---------- lectura ----------
  app.get("/api/merchant/bookings", async (req, reply) => {
    const q = parse(BookingsQuery, req.query, reply);
    if (!q) return;
    return run(req, (tx) => read.listBookings(tx, q));
  });

  app.get("/api/merchant/conversations", async (req, reply) => {
    const q = parse(ConversationsQuery, req.query, reply);
    if (!q) return;
    return run(req, (tx) => read.listConversations(tx, q));
  });

  app.get("/api/merchant/conversations/:id", async (req, reply) => {
    const params = IdParam.safeParse(req.params);
    if (!params.success) return notFound(reply, "Conversación no encontrada");
    return run(req, (tx) => read.getConversationDetail(tx, params.data.id));
  });

  // ---------- métricas ----------
  app.get("/api/merchant/metrics", async (req, reply) => {
    const q = parse(MetricsQuery, req.query, reply);
    if (!q) return;
    return run(req, (tx) => getMetrics(tx, q));
  });

  // ---------- bandeja de paso a humano (también el staff) ----------
  app.get("/api/merchant/handoff/count", (req) => run(req, inbox.handoffCount));

  app.post("/api/merchant/conversations/:id/reply", staffWrite, async (req, reply) => {
    const params = IdParam.safeParse(req.params);
    if (!params.success) return notFound(reply, "Conversación no encontrada");
    const input = parse(StaffReply, req.body, reply);
    if (!input) return;
    const conversationId = params.data.id;
    await run(req, (tx) => inbox.staffReply(tx, { conversationId, userId: req.merchantUserId, text: input.text, now: clock() }));
    return run(req, (tx) => read.getConversationDetail(tx, conversationId));
  });

  app.post("/api/merchant/conversations/:id/take", staffWrite, async (req, reply) => {
    const params = IdParam.safeParse(req.params);
    if (!params.success) return notFound(reply, "Conversación no encontrada");
    const conversationId = params.data.id;
    await run(req, (tx) => inbox.takeConversation(tx, { conversationId, userId: req.merchantUserId, now: clock() }));
    return run(req, (tx) => read.getConversationDetail(tx, conversationId));
  });

  app.post("/api/merchant/conversations/:id/release", staffWrite, async (req, reply) => {
    const params = IdParam.safeParse(req.params);
    if (!params.success) return notFound(reply, "Conversación no encontrada");
    const conversationId = params.data.id;
    await run(req, (tx) => inbox.releaseConversation(tx, { conversationId, now: clock() }));
    return run(req, (tx) => read.getConversationDetail(tx, conversationId));
  });

  // ---------- errores ----------
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof MerchantError) {
      const status = { not_found: 404, conflict: 409, unprocessable: 422 }[err.code];
      return reply
        .code(status)
        .send({ error: err.code, reason: err.reason, message: err.message, ...(err.details ? { details: err.details } : {}) });
    }
    if (err instanceof BookingError) {
      // fecha u hora mal formadas, servicio que no es de este negocio
      const reason: ErrorReason = err.code === "service_not_found" ? "service_not_found" : "not_found";
      if (err.code === "invalid_input") {
        return reply.code(400).send({ error: "invalid_input", message: err.message });
      }
      return reply.code(404).send({ error: "not_found", reason, message: err.message });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status === 413) {
      return reply.code(413).send({ error: "too_large", reason: "logo_too_large", message: "El archivo puede pesar hasta 256 KB" });
    }
    if (status === 415) {
      return reply.code(415).send({ error: "unsupported_media_type", reason: "logo_invalid", message: "Formato no admitido" });
    }
    if (status === 400) {
      return reply.code(400).send({ error: "invalid_request", message: (err as Error).message });
    }
    req.log.error({ err }, "error en la consola del merchant");
    return reply.code(500).send({ error: "internal", message: "Algo falló. Intenta de nuevo." });
  });
}

/** Valida con el contrato; si no cumple, responde 400 con el detalle por campo. */
export function parse<S extends z.ZodType>(schema: S, value: unknown, reply: FastifyReply): z.infer<S> | undefined {
  const result = schema.safeParse(value ?? {});
  if (result.success) return result.data;
  reply.code(400).send({
    error: "invalid_input",
    message: "Revisa los datos enviados",
    issues: result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
  });
  return undefined;
}

/** Motivo de una acción de reserva que no se pudo hacer → código HTTP y motivo para la consola. */
function failure(reply: FastifyReply, reason: StaffActionFailure) {
  const map: Record<StaffActionFailure, [number, ErrorReason, string]> = {
    not_found: [404, "not_found", "Reserva no encontrada"],
    not_allowed: [409, "booking_not_allowed", "La reserva ya no admite ese cambio"],
    slot_unavailable: [409, "slot_unavailable", "Ese horario no está disponible"],
    slot_taken: [409, "slot_taken", "Ese horario se acaba de ocupar"],
    in_past: [422, "in_past", "El horario ya pasó"],
    staff_not_found: [422, "staff_not_found", "Ese profesional no hace este servicio"],
    invalid_customer: [422, "invalid_customer", "Indica el nombre y un teléfono o email válidos"],
  };
  const [status, r, message] = map[reason];
  const error = status === 404 ? "not_found" : status === 409 ? "conflict" : "unprocessable";
  return reply.code(status).send({ error, reason: r, message });
}

export function notFound(reply: FastifyReply, message: string) {
  return reply.code(404).send({ error: "not_found", message });
}
