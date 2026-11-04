import type pg from "pg";

/**
 * "Salón Aurora": negocio de ejemplo (en Santiago de Chile, precios en pesos) para
 * probar el chat a mano y para los tests de comportamiento del agente. Ids fijos para poder referirlos.
 */
export const AURORA = {
  tenant: "a0a0a0a0-0000-4000-8000-000000000001",
  location: "a0a0a0a0-0000-4000-8000-000000000002",
  slug: "salon-aurora",
  timezone: "America/Santiago",
  staff: {
    valeria: "a0a0a0a0-0000-4000-8000-000000000101",
    camila: "a0a0a0a0-0000-4000-8000-000000000102",
    diego: "a0a0a0a0-0000-4000-8000-000000000103",
  },
  services: {
    corteMujer: "a0a0a0a0-0000-4000-8000-000000000201",
    corteHombre: "a0a0a0a0-0000-4000-8000-000000000202",
    color: "a0a0a0a0-0000-4000-8000-000000000203",
    peinado: "a0a0a0a0-0000-4000-8000-000000000204",
    manicure: "a0a0a0a0-0000-4000-8000-000000000205",
  },
} as const;

const INSTRUCTIONS = `Dirección: Av. Providencia 1234, local 5, Providencia, Santiago (a media cuadra del metro Pedro de Valdivia, línea 1).
Estacionamiento: en la calle con parquímetro, o en el estacionamiento pagado de la esquina.
Medios de pago: tarjeta de débito y crédito, transferencia y efectivo. No se cobra adelanto.
Atendemos en español e inglés.
Preguntas frecuentes:
- Color: si es la primera vez, conviene llegar 10 minutos antes para la consulta. Incluye lavado.
- Cortes: incluyen lavado y secado.
- Niños: cortamos a niños desde 4 años como corte de hombre o de mujer.
- Retrasos: tras 15 minutos de atraso puede que haya que reprogramar.`;

const INSTRUCTIONS_EN = `Address: Av. Providencia 1234, suite 5, Providencia, Santiago (half a block from Pedro de Valdivia metro station, line 1).
Parking: metered street parking, or the paid parking lot on the corner.
Payment: debit and credit card, bank transfer and cash. No deposit required.
We speak Spanish and English.
FAQ:
- Color: if it's your first time, please arrive 10 minutes early for a consultation. Includes a wash.
- Haircuts: include wash and blow-dry.
- Kids: we cut kids' hair from age 4 as a men's or women's cut.
- Running late: after 15 minutes we may need to reschedule.`;

const HANDOFF = "- Si pide un presupuesto para novias o eventos.\n- Si tiene una alergia o una reacción a un producto.";
const HANDOFF_EN = "- If they ask for a bridal or event quote.\n- If they mention an allergy or a reaction to a product.";

/** Estilo del chat: rosa empolvado, como el teléfono del cliente, bienvenida en los dos idiomas. */
const CHAT_SETTINGS = {
  palette: "rosa",
  accent: null,
  appearance: "auto",
  welcome: {
    es: "¡Hola! Soy el asistente del Salón Aurora. Puedo reservarte, cambiar o cancelar una hora. ¿Qué necesitas?",
    en: "Hi! I'm Salón Aurora's assistant. I can book, move or cancel an appointment for you. What do you need?",
  },
};

/**
 * Crea (o vuelve a crear) el Salón Aurora. Borra solo los datos de este
 * negocio, incluidas sus reservas y conversaciones; los demás no se tocan.
 * Usar una conexión con un rol dueño del esquema (no `app_user`).
 */
export async function seedSalonAurora(db: pg.Pool): Promise<void> {
  const tx = await db.connect();
  try {
    await tx.query("BEGIN");
    await clear(tx, AURORA.tenant);
    await insert(tx);
    await tx.query("COMMIT");
  } catch (err) {
    await tx.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    tx.release();
  }
}

async function clear(tx: pg.PoolClient, tenantId: string) {
  // en orden: primero lo que referencia a lo demás
  for (const table of [
    "support_access_log",
    "location_logos",
    "tool_calls",
    "llm_usage",
    "conversation_messages",
    "wa_inbound_events",
    "booking_events",
    "booking_resources",
    "bookings",
    "conversations",
    "customers",
    "booking_policies",
    "availability_exceptions",
    "availability_rules",
    "service_resources",
    "services",
    "resource_combinations",
    "resources",
    "locations",
  ]) {
    await tx.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [tenantId]);
  }
  await tx.query("DELETE FROM tenants WHERE id = $1", [tenantId]);
}

async function insert(tx: pg.PoolClient) {
  const A = AURORA;
  const q = (sql: string, params: unknown[]) => tx.query(sql, params);

  await q(`INSERT INTO tenants (id, name, vertical, modules, country, currency) VALUES ($1, 'Salón Aurora', 'salon', '{booking}', 'CL', 'CLP')`, [A.tenant]);
  // plan con espacio para su equipo de 3 (el Inicial permite justo 3); si no existe, queda el por defecto
  await q(`UPDATE tenants SET plan_id = coalesce((SELECT id FROM plans WHERE name = 'Profesional'), plan_id) WHERE id = $1`, [A.tenant]);
  await q(
    `INSERT INTO locations (id, tenant_id, name, timezone, address, web_chat_slug, default_locale, chat_settings, chat_enabled,
                            agent_tone, agent_instructions, agent_instructions_en, agent_handoff, agent_handoff_en)
     VALUES ($1, $2, 'Providencia', $3, 'Av. Providencia 1234, local 5, Providencia, Santiago', $4, 'es', $5, true,
             'warm', $6, $7, $8, $9)`,
    [A.location, A.tenant, A.timezone, A.slug, JSON.stringify(CHAT_SETTINGS), INSTRUCTIONS, INSTRUCTIONS_EN, HANDOFF, HANDOFF_EN],
  );

  // Equipo
  const staff: [string, string, number][] = [
    [A.staff.valeria, "Valeria", 1],
    [A.staff.camila, "Camila", 2],
    [A.staff.diego, "Diego", 3],
  ];
  for (const [id, name, order] of staff) {
    await q(
      `INSERT INTO resources (id, tenant_id, location_id, kind, name, sort_order) VALUES ($1, $2, $3, 'staff', $4, $5)`,
      [id, A.tenant, A.location, name, order],
    );
  }

  // Servicios: [id, nombre, descripción, nombre en inglés, descripción en inglés, minutos, limpieza, precio en pesos, quién lo hace]
  const services: [string, string, string, string, string, number, number, number, string[]][] = [
    [A.services.corteMujer, "Corte de mujer", "Corte con lavado y secado.", "Women's haircut", "Cut with wash and blow-dry.", 60, 0, 18000, [A.staff.valeria, A.staff.camila]],
    [A.services.corteHombre, "Corte de hombre", "Corte con máquina o tijera; incluye lavado.", "Men's haircut", "Clipper or scissor cut; includes a wash.", 30, 0, 12000, [A.staff.diego]],
    [A.services.color, "Color", "Tinte completo con lavado. Si es tu primera vez, llega 10 minutos antes.", "Color", "Full color with wash. If it's your first time, arrive 10 minutes early.", 120, 15, 45000, [A.staff.valeria]],
    [A.services.peinado, "Peinado", "Brushing, ondas o recogido para eventos.", "Styling", "Blowout, waves or an updo for events.", 45, 0, 20000, [A.staff.valeria]],
    [A.services.manicure, "Manicure", "Limado, cutículas y esmaltado tradicional.", "Manicure", "Filing, cuticle care and regular polish.", 45, 0, 12000, [A.staff.camila]],
  ];
  for (const [id, name, description, nameEn, descriptionEn, minutes, buffer, price, who] of services) {
    await q(
      `INSERT INTO services (id, tenant_id, location_id, name, description, name_en, description_en, resource_kind,
                             duration_min, buffer_after_min, price)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'staff', $8, $9, $10)`,
      [id, A.tenant, A.location, name, description, nameEn, descriptionEn, minutes, buffer, price],
    );
    for (const resourceId of who) {
      await q(`INSERT INTO service_resources (service_id, resource_id, tenant_id) VALUES ($1, $2, $3)`, [
        id,
        resourceId,
        A.tenant,
      ]);
    }
  }

  // Horario del local: martes (2) a sábado (6), 9:00 a 19:00. Domingo y lunes cerrado.
  // Horario de cada profesional, dentro del horario del local.
  const rules: [string | null, number[], string, string][] = [
    [null, [2, 3, 4, 5, 6], "09:00", "19:00"],
    [A.staff.valeria, [2, 3, 4, 5, 6], "09:00", "19:00"],
    [A.staff.camila, [2, 3, 4, 5], "09:00", "15:00"],
    [A.staff.diego, [4, 5, 6], "12:00", "19:00"],
  ];
  for (const [resourceId, weekdays, start, end] of rules) {
    for (const weekday of weekdays) {
      await q(
        `INSERT INTO availability_rules (tenant_id, location_id, resource_id, weekday, start_time, end_time)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [A.tenant, A.location, resourceId, weekday, start, end],
      );
    }
  }

  // Feriado: Thanksgiving 2026, todo el día en hora local
  await q(
    `INSERT INTO availability_exceptions (tenant_id, location_id, period, kind, reason)
     VALUES ($1, $2, tstzrange(timestamp '2026-11-26 00:00' AT TIME ZONE $3, timestamp '2026-11-27 00:00' AT TIME ZONE $3), 'closed', 'Thanksgiving')`,
    [A.tenant, A.location, A.timezone],
  );

  await q(
    `INSERT INTO booking_policies (tenant_id, location_id, slot_interval_min, min_lead_time_min, max_advance_days,
                                   cancel_cutoff_min, hold_ttl_sec, auto_confirm)
     VALUES ($1, $2, 15, 60, 60, 240, 300, true)`,
    [A.tenant, A.location],
  );
}
