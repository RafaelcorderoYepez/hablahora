import pg from "pg";

export const IDS = {
  // Tenant A: restaurante en Nueva York
  tenantA: "a0000000-0000-4000-8000-000000000001",
  locA: "a0000000-0000-4000-8000-000000000002",
  mesa1: "a0000000-0000-4000-8000-000000000011", // 1-2 personas
  mesa2: "a0000000-0000-4000-8000-000000000012", // 2-4 personas
  cena: "a0000000-0000-4000-8000-000000000021",
  // Tenant B: peluquería en Miami, confirma a mano
  tenantB: "b0000000-0000-4000-8000-000000000001",
  locB: "b0000000-0000-4000-8000-000000000002",
  ana: "b0000000-0000-4000-8000-000000000011",
  corte: "b0000000-0000-4000-8000-000000000021",
};

/** Siembra datos con el superusuario (ignora RLS). */
export async function seed(admin: pg.Pool) {
  await admin.query(`
    TRUNCATE tenants, locations, resources, resource_combinations, services, service_resources,
             availability_rules, availability_exceptions, booking_policies, customers,
             bookings, booking_resources, booking_events,
             conversations, conversation_messages, wa_inbound_events, llm_usage, tool_calls CASCADE`);

  const q = (sql: string, params: unknown[]) => admin.query(sql, params);
  const I = IDS;

  // negocios de EE.UU. (dólares, teléfonos +1); el Salón Aurora del seed es de Chile
  await q(`INSERT INTO tenants (id, name, vertical, modules, country, currency) VALUES
            ($1, 'Trattoria Demo', 'restaurant', '{booking}', 'US', 'USD'),
            ($2, 'Salón Demo', 'salon', '{booking}', 'US', 'USD')`, [I.tenantA, I.tenantB]);
  await q(`INSERT INTO locations (id, tenant_id, name, timezone, wa_phone_number_id, web_chat_slug, agent_instructions, chat_enabled) VALUES
            ($1, $2, 'Centro', 'America/New_York', 'wa-111', 'trattoria-demo', 'Cocina italiana. Estacionamiento en la calle.', true),
            ($3, $4, 'Brickell', 'America/New_York', 'wa-222', 'salon-demo', NULL, true)`, [I.locA, I.tenantA, I.locB, I.tenantB]);

  await q(`INSERT INTO resources (id, tenant_id, location_id, kind, name, capacity_min, capacity_max, sort_order) VALUES
            ($1, $3, $4, 'table', 'Mesa 1', 1, 2, 1),
            ($2, $3, $4, 'table', 'Mesa 2', 2, 4, 2)`, [I.mesa1, I.mesa2, I.tenantA, I.locA]);
  await q(`INSERT INTO services (id, tenant_id, location_id, name, resource_kind, duration_min, duration_rules, buffer_after_min)
           VALUES ($1, $2, $3, 'Mesa cena', 'table', 90,
                   '[{"party_max":2,"min":75},{"party_max":6,"min":105}]', 15)`, [I.cena, I.tenantA, I.locA]);
  await q(`INSERT INTO service_resources (service_id, resource_id, tenant_id) VALUES ($1, $2, $4), ($1, $3, $4)`,
    [I.cena, I.mesa1, I.mesa2, I.tenantA]);
  await q(`INSERT INTO availability_rules (tenant_id, location_id, weekday, start_time, end_time)
           SELECT $1, $2, d, '18:00', '23:00' FROM generate_series(0, 6) d`, [I.tenantA, I.locA]);
  await q(`INSERT INTO booking_policies (tenant_id, location_id, slot_interval_min, min_lead_time_min,
             max_advance_days, cancel_cutoff_min, hold_ttl_sec, auto_confirm)
           VALUES ($1, $2, 15, 60, 60, 120, 300, true)`, [I.tenantA, I.locA]);

  await q(`INSERT INTO resources (id, tenant_id, location_id, kind, name) VALUES ($1, $2, $3, 'staff', 'Ana')`,
    [I.ana, I.tenantB, I.locB]);
  await q(`INSERT INTO services (id, tenant_id, location_id, name, resource_kind, duration_min)
           VALUES ($1, $2, $3, 'Corte de pelo', 'staff', 45)`, [I.corte, I.tenantB, I.locB]);
  await q(`INSERT INTO service_resources (service_id, resource_id, tenant_id) VALUES ($1, $2, $3)`,
    [I.corte, I.ana, I.tenantB]);
  await q(`INSERT INTO availability_rules (tenant_id, location_id, weekday, start_time, end_time)
           SELECT $1, $2, d, '09:00', '17:00' FROM generate_series(0, 6) d`, [I.tenantB, I.locB]);
  await q(`INSERT INTO booking_policies (tenant_id, location_id, auto_confirm) VALUES ($1, $2, false)`,
    [I.tenantB, I.locB]);
}

export async function clearBookings(admin: pg.Pool) {
  await admin.query(
    `TRUNCATE customers, bookings, booking_resources, booking_events,
              conversations, conversation_messages, wa_inbound_events, llm_usage, tool_calls CASCADE`,
  );
}
