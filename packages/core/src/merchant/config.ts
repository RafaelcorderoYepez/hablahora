import { ChatSettings, DEFAULT_CHAT_SETTINGS } from "@hablahora/contracts";
import type {
  Business,
  BusinessPatch,
  Closure,
  ClosureCreate,
  Hours,
  Policies,
  Service,
  ServiceCreate,
  ServicePatch,
  Staff,
  StaffCreate,
  StaffPatch,
  StaffPatchResult,
  WeeklySchedule,
} from "@hablahora/contracts";
import { DEFAULT_POLICY } from "../db/repository.js";
import { getReadiness } from "./onboarding.js";
import { activeStaffCount, currentTenantGate } from "../platform/limits.js";
import type { Tx } from "../db/tenant.js";
import {
  isUniqueViolation,
  localDate,
  MerchantError,
  nextLocalDay,
  primaryLocation,
  replaceSchedule,
  SCHEDULE_COLUMNS,
  startOfLocalDay,
  toSchedule,
} from "./common.js";

// Todas estas funciones corren dentro de withTenant(): RLS limita cada consulta
// al negocio de quien llama. `tenants` no tiene RLS, por eso se filtra por
// current_setting('app.tenant_id') (el mismo tenant que fijó withTenant).
const CURRENT_TENANT = "current_setting('app.tenant_id')::uuid";

// ---------------------------------------------------------------------
// Negocio
// ---------------------------------------------------------------------

export async function getBusiness(tx: Tx): Promise<Business> {
  const loc = await primaryLocation(tx);
  const { rows } = await tx.query(
    `SELECT t.name, t.country, t.currency, l.name AS location_name, l.address, l.timezone, l.default_locale,
            l.agent_tone, l.agent_instructions, l.agent_instructions_en, l.agent_handoff, l.agent_handoff_en,
            l.web_chat_slug, l.chat_enabled, l.chat_settings
       FROM locations l JOIN tenants t ON t.id = l.tenant_id
      WHERE l.id = $1 AND t.id = ${CURRENT_TENANT}`,
    [loc.id],
  );
  const r = rows[0];
  return {
    name: r.name,
    locationName: r.location_name,
    address: r.address,
    country: r.country,
    currency: r.currency,
    timezone: r.timezone,
    defaultLocale: r.default_locale,
    agentTone: r.agent_tone,
    agentInstructions: r.agent_instructions,
    agentInstructionsEn: r.agent_instructions_en,
    agentHandoff: r.agent_handoff,
    agentHandoffEn: r.agent_handoff_en,
    webChatSlug: r.web_chat_slug,
    chatEnabled: r.chat_enabled,
    chatSettings: parseChatSettings(r.chat_settings),
  };
}

/** Estilo guardado; si falta o quedó inválido, los valores por defecto. */
export function parseChatSettings(raw: unknown): ChatSettings {
  const parsed = ChatSettings.safeParse(raw ?? {});
  return parsed.success ? parsed.data : DEFAULT_CHAT_SETTINGS;
}

export async function updateBusiness(tx: Tx, patch: BusinessPatch): Promise<Business> {
  const loc = await primaryLocation(tx);
  if (patch.name !== undefined) {
    await tx.query(`UPDATE tenants SET name = $1 WHERE id = ${CURRENT_TENANT}`, [patch.name]);
  }
  const columns: [keyof BusinessPatch, string][] = [
    ["locationName", "name"],
    ["address", "address"],
    ["timezone", "timezone"],
    ["defaultLocale", "default_locale"],
    ["agentTone", "agent_tone"],
    ["agentInstructions", "agent_instructions"],
    ["agentInstructionsEn", "agent_instructions_en"],
    ["agentHandoff", "agent_handoff"],
    ["agentHandoffEn", "agent_handoff_en"],
    ["webChatSlug", "web_chat_slug"],
    ["chatEnabled", "chat_enabled"],
    ["chatSettings", "chat_settings"],
  ];
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [key, column] of columns) {
    if (patch[key] === undefined) continue;
    // textos vacíos se guardan como "sin dato"
    const value = typeof patch[key] === "string" && !(patch[key] as string).trim() ? null : patch[key];
    values.push(key === "chatSettings" ? JSON.stringify(value) : value);
    sets.push(`${column} = $${values.length}`);
  }
  if (sets.length) {
    values.push(loc.id);
    if (patch.chatEnabled === true) await assertReadyToEnable(tx, patch);
    try {
      await tx.query("SAVEPOINT slug");
      await tx.query(`UPDATE locations SET ${sets.join(", ")} WHERE id = $${values.length}`, values);
      await tx.query("RELEASE SAVEPOINT slug");
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      throw new MerchantError("conflict", "Ese enlace del chat ya lo usa otro negocio", "slug_taken");
    }
  }
  return getBusiness(tx);
}

/**
 * Activar el chat exige lo mínimo (servicio con profesional, horario, enlace).
 * El enlace puede llegar en el mismo cambio; desactivarlo siempre se puede.
 */
async function assertReadyToEnable(tx: Tx, patch: BusinessPatch) {
  const readiness = await getReadiness(tx);
  const missing = readiness.checks
    .filter((c) => c.required && !c.ok)
    .filter((c) => !(c.key === "web_chat_slug" && patch.webChatSlug))
    .map((c) => c.key);
  if (missing.length) {
    throw new MerchantError("unprocessable", "Para activar el chat falta configurar lo mínimo", "chat_not_ready", {
      missing,
    });
  }
}

// ---------------------------------------------------------------------
// Servicios
// ---------------------------------------------------------------------

export async function listServices(tx: Tx): Promise<Service[]> {
  const loc = await primaryLocation(tx);
  const { rows } = await tx.query(
    `SELECT s.*, coalesce(array_agg(sr.resource_id ORDER BY sr.resource_id) FILTER (WHERE sr.resource_id IS NOT NULL), '{}') AS staff_ids
       FROM services s LEFT JOIN service_resources sr ON sr.service_id = s.id
      WHERE s.location_id = $1 AND s.resource_kind = 'staff'
      GROUP BY s.id
      ORDER BY s.is_active DESC, s.name`,
    [loc.id],
  );
  return rows.map(mapService);
}

async function getService(tx: Tx, id: string): Promise<Service> {
  const found = (await listServices(tx)).find((s) => s.id === id);
  if (!found) throw new MerchantError("not_found", "Servicio no encontrado");
  return found;
}

export async function createService(tx: Tx, input: ServiceCreate): Promise<Service> {
  const loc = await primaryLocation(tx);
  await checkServiceStaff(tx, loc.id, input.active, input.staffIds);
  const { rows } = await tx.query(
    `INSERT INTO services (tenant_id, location_id, name, description, name_en, description_en, resource_kind,
                           duration_min, buffer_after_min, price, is_active)
     VALUES (${CURRENT_TENANT}, $1, $2, $3, $4, $5, 'staff', $6, $7, $8, $9)
     RETURNING id`,
    [
      loc.id,
      input.name,
      emptyToNull(input.description),
      emptyToNull(input.nameEn),
      emptyToNull(input.descriptionEn),
      input.durationMin,
      input.bufferAfterMin,
      input.price,
      input.active,
    ],
  );
  await setServiceStaff(tx, rows[0].id, input.staffIds);
  return getService(tx, rows[0].id);
}

export async function updateService(tx: Tx, id: string, patch: ServicePatch): Promise<Service> {
  const loc = await primaryLocation(tx);
  const current = await getService(tx, id);
  const next = { ...current, ...patch };
  await checkServiceStaff(tx, loc.id, next.active, next.staffIds);
  await tx.query(
    `UPDATE services SET name = $2, description = $3, name_en = $4, description_en = $5, duration_min = $6,
                         buffer_after_min = $7, price = $8, is_active = $9
      WHERE id = $1`,
    [
      id,
      next.name,
      emptyToNull(next.description),
      emptyToNull(next.nameEn),
      emptyToNull(next.descriptionEn),
      next.durationMin,
      next.bufferAfterMin,
      next.price,
      next.active,
    ],
  );
  if (patch.staffIds) await setServiceStaff(tx, id, patch.staffIds);
  return getService(tx, id);
}

/** Los profesionales existen en esta sucursal; un servicio activo necesita al menos uno activo. */
async function checkServiceStaff(tx: Tx, locationId: string, active: boolean, staffIds: string[]) {
  const { rows } = await tx.query(
    "SELECT id, is_active FROM resources WHERE location_id = $1 AND kind = 'staff' AND id = ANY($2)",
    [locationId, staffIds],
  );
  if (rows.length !== new Set(staffIds).size) throw new MerchantError("unprocessable", "Profesional no encontrado", "staff_not_found");
  if (active && !rows.some((r) => r.is_active)) {
    throw new MerchantError(
      "unprocessable",
      "Un servicio activo necesita al menos un profesional activo que lo haga",
      "service_needs_staff",
    );
  }
}

async function setServiceStaff(tx: Tx, serviceId: string, staffIds: string[]) {
  await tx.query("DELETE FROM service_resources WHERE service_id = $1", [serviceId]);
  for (const resourceId of new Set(staffIds)) {
    await tx.query(
      `INSERT INTO service_resources (service_id, resource_id, tenant_id) VALUES ($1, $2, ${CURRENT_TENANT})`,
      [serviceId, resourceId],
    );
  }
}

function mapService(r: any): Service {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    nameEn: r.name_en,
    descriptionEn: r.description_en,
    durationMin: r.duration_min,
    bufferAfterMin: r.buffer_after_min,
    price: r.price,
    active: r.is_active,
    staffIds: r.staff_ids,
  };
}

// ---------------------------------------------------------------------
// Equipo
// ---------------------------------------------------------------------

export async function listStaff(tx: Tx): Promise<Staff[]> {
  const loc = await primaryLocation(tx);
  const { rows } = await tx.query(
    `SELECT r.id, r.name, r.is_active,
            coalesce(array_agg(sr.service_id ORDER BY sr.service_id) FILTER (WHERE sr.service_id IS NOT NULL), '{}') AS service_ids
       FROM resources r LEFT JOIN service_resources sr ON sr.resource_id = r.id
      WHERE r.location_id = $1 AND r.kind = 'staff'
      GROUP BY r.id
      ORDER BY r.is_active DESC, r.sort_order, r.name`,
    [loc.id],
  );
  const rules = await tx.query(
    `SELECT resource_id, ${SCHEDULE_COLUMNS} FROM availability_rules WHERE location_id = $1 AND resource_id IS NOT NULL`,
    [loc.id],
  );
  return rows.map((r) => {
    const own = rules.rows.filter((x) => x.resource_id === r.id);
    return {
      id: r.id,
      name: r.name,
      active: r.is_active,
      serviceIds: r.service_ids,
      schedule: own.length ? toSchedule(own) : null,
    };
  });
}

async function getStaff(tx: Tx, id: string): Promise<Staff> {
  const found = (await listStaff(tx)).find((s) => s.id === id);
  if (!found) throw new MerchantError("not_found", "Profesional no encontrado");
  return found;
}

/** Límite de profesionales activos del plan (al crear uno activo o reactivarlo). */
async function assertStaffLimit(tx: Tx, locationId: string): Promise<void> {
  const { maxActiveStaff, planName } = await currentTenantGate(tx);
  if (maxActiveStaff != null && (await activeStaffCount(tx, locationId)) >= maxActiveStaff) {
    throw new MerchantError("conflict", `El plan ${planName} permite ${maxActiveStaff} profesionales activos`, "plan_limit_staff", {
      plan: planName,
      max: maxActiveStaff,
    });
  }
}

export async function createStaff(tx: Tx, input: StaffCreate): Promise<Staff> {
  const loc = await primaryLocation(tx);
  await checkServices(tx, loc.id, input.serviceIds);
  if (input.active) await assertStaffLimit(tx, loc.id);
  const { rows } = await tx.query(
    `INSERT INTO resources (tenant_id, location_id, kind, name, is_active, sort_order)
     VALUES (${CURRENT_TENANT}, $1, 'staff', $2, $3,
             (SELECT coalesce(max(sort_order), 0) + 1 FROM resources WHERE location_id = $1))
     RETURNING id`,
    [loc.id, input.name, input.active],
  );
  await setStaffServices(tx, rows[0].id, input.serviceIds);
  return getStaff(tx, rows[0].id);
}

/**
 * Modifica un profesional. Desactivarlo no cancela sus reservas: la respuesta
 * avisa cuántas futuras tiene y qué servicios activos quedaron sin nadie.
 */
export async function updateStaff(tx: Tx, id: string, patch: StaffPatch, now: Date): Promise<StaffPatchResult> {
  const loc = await primaryLocation(tx);
  const current = await getStaff(tx, id);
  if (patch.serviceIds) await checkServices(tx, loc.id, patch.serviceIds);
  if (patch.active === true && !current.active) await assertStaffLimit(tx, loc.id);
  if (patch.name !== undefined || patch.active !== undefined) {
    await tx.query("UPDATE resources SET name = coalesce($2, name), is_active = coalesce($3, is_active) WHERE id = $1", [
      id,
      patch.name ?? null,
      patch.active ?? null,
    ]);
  }
  if (patch.serviceIds) await setStaffServices(tx, id, patch.serviceIds);

  const future = await tx.query(
    `SELECT count(DISTINCT b.id)::int AS n
       FROM bookings b JOIN booking_resources br ON br.booking_id = b.id
      WHERE br.resource_id = $1 AND br.is_active AND b.status IN ('pending', 'confirmed') AND b.starts_at >= $2`,
    [id, now],
  );
  const orphans = await tx.query(
    `SELECT s.name FROM services s
      WHERE s.location_id = $1 AND s.is_active AND s.resource_kind = 'staff'
        AND NOT EXISTS (SELECT 1 FROM service_resources sr JOIN resources r ON r.id = sr.resource_id
                         WHERE sr.service_id = s.id AND r.is_active)
      ORDER BY s.name`,
    [loc.id],
  );
  return {
    ...(await getStaff(tx, id)),
    futureBookings: future.rows[0].n,
    servicesWithoutStaff: orphans.rows.map((r) => r.name),
  };
}

/** Horario propio del profesional; null = el mismo del local. */
export async function setStaffSchedule(tx: Tx, id: string, schedule: WeeklySchedule | null): Promise<Staff> {
  const loc = await primaryLocation(tx);
  await getStaff(tx, id);
  const { rows } = await tx.query(`SELECT ${CURRENT_TENANT} AS tenant_id`);
  await replaceSchedule(tx, { tenantId: rows[0].tenant_id, locationId: loc.id, resourceId: id, schedule });
  return getStaff(tx, id);
}

async function checkServices(tx: Tx, locationId: string, serviceIds: string[]) {
  const { rows } = await tx.query("SELECT id FROM services WHERE location_id = $1 AND id = ANY($2)", [
    locationId,
    serviceIds,
  ]);
  if (rows.length !== new Set(serviceIds).size) throw new MerchantError("unprocessable", "Servicio no encontrado", "service_not_found");
}

async function setStaffServices(tx: Tx, resourceId: string, serviceIds: string[]) {
  await tx.query("DELETE FROM service_resources WHERE resource_id = $1", [resourceId]);
  for (const serviceId of new Set(serviceIds)) {
    await tx.query(
      `INSERT INTO service_resources (service_id, resource_id, tenant_id) VALUES ($1, $2, ${CURRENT_TENANT})`,
      [serviceId, resourceId],
    );
  }
}

// ---------------------------------------------------------------------
// Horario del local y cierres
// ---------------------------------------------------------------------

export async function getHours(tx: Tx): Promise<Hours> {
  const loc = await primaryLocation(tx);
  const { rows } = await tx.query(
    `SELECT ${SCHEDULE_COLUMNS} FROM availability_rules WHERE location_id = $1 AND resource_id IS NULL`,
    [loc.id],
  );
  return { schedule: toSchedule(rows) };
}

/** Reemplaza el horario semanal del local entero. */
export async function setHours(tx: Tx, hours: Hours): Promise<Hours> {
  const loc = await primaryLocation(tx);
  const { rows } = await tx.query(`SELECT ${CURRENT_TENANT} AS tenant_id`);
  await replaceSchedule(tx, { tenantId: rows[0].tenant_id, locationId: loc.id, resourceId: null, schedule: hours.schedule });
  return getHours(tx);
}

export async function listClosures(tx: Tx): Promise<Closure[]> {
  const loc = await primaryLocation(tx);
  const { rows } = await tx.query(
    `SELECT id, resource_id, lower(period) AS starts, upper(period) AS ends, reason
       FROM availability_exceptions
      WHERE location_id = $1 AND kind = 'closed'
      ORDER BY lower(period)`,
    [loc.id],
  );
  return rows.map((r) => ({
    id: r.id,
    from: localDate(r.starts, loc.timezone),
    // el período termina al inicio del día siguiente al último cerrado
    to: localDate(new Date(r.ends.getTime() - 1), loc.timezone),
    staffId: r.resource_id,
    reason: r.reason,
  }));
}

/** Cierre por días completos en fecha local, de todo el local o de un profesional. */
export async function createClosure(tx: Tx, input: ClosureCreate): Promise<Closure> {
  const loc = await primaryLocation(tx);
  if (input.staffId) await getStaff(tx, input.staffId);
  const { rows } = await tx.query(
    `INSERT INTO availability_exceptions (tenant_id, location_id, resource_id, period, kind, reason)
     VALUES (${CURRENT_TENANT}, $1, $2, tstzrange($3, $4, '[)'), 'closed', $5)
     RETURNING id`,
    [loc.id, input.staffId, startOfLocalDay(input.from, loc.timezone), nextLocalDay(input.to, loc.timezone), input.reason],
  );
  const created = (await listClosures(tx)).find((c) => c.id === rows[0].id)!;
  return created;
}

export async function deleteClosure(tx: Tx, id: string): Promise<void> {
  const loc = await primaryLocation(tx);
  const { rowCount } = await tx.query(
    "DELETE FROM availability_exceptions WHERE id = $1 AND location_id = $2 AND kind = 'closed'",
    [id, loc.id],
  );
  if (!rowCount) throw new MerchantError("not_found", "Cierre no encontrado");
}

// ---------------------------------------------------------------------
// Políticas (nivel sucursal; las de servicio quedan para después)
// ---------------------------------------------------------------------

export async function getPolicies(tx: Tx): Promise<Policies> {
  const loc = await primaryLocation(tx);
  const { rows } = await tx.query("SELECT * FROM booking_policies WHERE location_id = $1 AND service_id IS NULL", [
    loc.id,
  ]);
  const p = rows[0];
  return {
    slotIntervalMin: (p?.slot_interval_min ?? DEFAULT_POLICY.slotIntervalMin) as Policies["slotIntervalMin"],
    minLeadTimeMin: p?.min_lead_time_min ?? DEFAULT_POLICY.minLeadTimeMin,
    maxAdvanceDays: p?.max_advance_days ?? DEFAULT_POLICY.maxAdvanceDays,
    cancelCutoffMin: p?.cancel_cutoff_min ?? DEFAULT_POLICY.cancelCutoffMin,
    autoConfirm: p?.auto_confirm ?? DEFAULT_POLICY.autoConfirm,
  };
}

export async function setPolicies(tx: Tx, p: Policies): Promise<Policies> {
  const loc = await primaryLocation(tx);
  const values = [loc.id, p.slotIntervalMin, p.minLeadTimeMin, p.maxAdvanceDays, p.cancelCutoffMin, p.autoConfirm];
  // UNIQUE (location_id, service_id) no impide dos filas con service_id NULL: se actualiza o se inserta a mano
  const updated = await tx.query(
    `UPDATE booking_policies SET slot_interval_min = $2, min_lead_time_min = $3, max_advance_days = $4,
                                 cancel_cutoff_min = $5, auto_confirm = $6
      WHERE location_id = $1 AND service_id IS NULL`,
    values,
  );
  if (!updated.rowCount) {
    await tx.query(
      `INSERT INTO booking_policies (tenant_id, location_id, slot_interval_min, min_lead_time_min, max_advance_days,
                                     cancel_cutoff_min, auto_confirm)
       VALUES (${CURRENT_TENANT}, $1, $2, $3, $4, $5, $6)`,
      values,
    );
  }
  return getPolicies(tx);
}

function emptyToNull(v: string | null | undefined): string | null {
  return v && v.trim() ? v : null;
}
