import type { BusinessTemplate, CurrencyCode } from "@hablahora/contracts";
import { withTenant, type Db } from "../db/tenant.js";

// Plantillas por rubro para el alta de un negocio: servicios de ejemplo y un
// horario típico, para no empezar de cero. El negocio los edita después.

interface TemplateService {
  name: string;
  nameEn: string;
  description: string;
  descriptionEn: string;
  durationMin: number;
  /** en la unidad mínima de cada moneda: pesos y centavos */
  price: Record<CurrencyCode, number>;
}

interface Template {
  /** tenants.vertical */
  vertical: string;
  /** días (0 = domingo) y horario del local */
  weekdays: number[];
  start: string;
  end: string;
  services: TemplateService[];
}

export const TEMPLATES: Record<BusinessTemplate, Template> = {
  salon: {
    vertical: "salon",
    weekdays: [2, 3, 4, 5, 6],
    start: "09:00",
    end: "19:00",
    services: [
      { name: "Corte de mujer", nameEn: "Women's haircut", description: "Corte con lavado y secado.", descriptionEn: "Cut with wash and blow-dry.", durationMin: 60, price: { CLP: 18000, USD: 5500 } },
      { name: "Color", nameEn: "Color", description: "Tinte completo con lavado.", descriptionEn: "Full color with wash.", durationMin: 120, price: { CLP: 45000, USD: 12000 } },
      { name: "Peinado", nameEn: "Styling", description: "Brushing, ondas o recogido.", descriptionEn: "Blowout, waves or an updo.", durationMin: 45, price: { CLP: 20000, USD: 4000 } },
    ],
  },
  barberia: {
    vertical: "barbershop",
    weekdays: [1, 2, 3, 4, 5, 6],
    start: "09:00",
    end: "20:00",
    services: [
      { name: "Corte", nameEn: "Haircut", description: "Corte con máquina o tijera.", descriptionEn: "Clipper or scissor cut.", durationMin: 30, price: { CLP: 10000, USD: 3000 } },
      { name: "Barba", nameEn: "Beard trim", description: "Perfilado y arreglo de barba.", descriptionEn: "Beard shaping and trim.", durationMin: 20, price: { CLP: 7000, USD: 1800 } },
      { name: "Corte y barba", nameEn: "Haircut and beard", description: "Corte completo más arreglo de barba.", descriptionEn: "Full haircut plus beard trim.", durationMin: 45, price: { CLP: 15000, USD: 4500 } },
    ],
  },
  clinica: {
    vertical: "clinic",
    weekdays: [1, 2, 3, 4, 5],
    start: "08:00",
    end: "17:00",
    services: [
      { name: "Consulta general", nameEn: "General consultation", description: "Primera consulta o control.", descriptionEn: "First visit or follow-up.", durationMin: 30, price: { CLP: 35000, USD: 8000 } },
      { name: "Control", nameEn: "Follow-up", description: "Revisión de un tratamiento en curso.", descriptionEn: "Review of an ongoing treatment.", durationMin: 20, price: { CLP: 25000, USD: 5000 } },
    ],
  },
  estetica: {
    vertical: "aesthetics",
    weekdays: [2, 3, 4, 5, 6],
    start: "10:00",
    end: "19:00",
    services: [
      { name: "Limpieza facial", nameEn: "Facial cleansing", description: "Limpieza profunda e hidratación.", descriptionEn: "Deep cleansing and hydration.", durationMin: 60, price: { CLP: 30000, USD: 7000 } },
      { name: "Manicure", nameEn: "Manicure", description: "Limado, cutículas y esmaltado.", descriptionEn: "Filing, cuticle care and polish.", durationMin: 45, price: { CLP: 12000, USD: 2500 } },
      { name: "Depilación de cejas", nameEn: "Eyebrow waxing", description: "Diseño y depilación de cejas.", descriptionEn: "Eyebrow shaping and waxing.", durationMin: 20, price: { CLP: 8000, USD: 1500 } },
    ],
  },
};

/**
 * Carga la plantilla en un negocio recién creado: horario del local, un
 * profesional con el nombre del dueño (casi siempre también atiende) y los
 * servicios, que ese profesional hace, con precios en la moneda del negocio.
 * El chat queda apagado hasta que el negocio lo active.
 */
export async function applyTemplate(db: Db, tenantId: string, template: BusinessTemplate, staffName: string): Promise<void> {
  const t = TEMPLATES[template];
  const { rows: tenant } = await db.query("UPDATE tenants SET vertical = $2 WHERE id = $1 RETURNING currency", [tenantId, t.vertical]);
  const currency = tenant[0].currency as CurrencyCode;
  await withTenant(db, tenantId, async (tx) => {
    const { rows } = await tx.query("SELECT id FROM locations ORDER BY created_at, id LIMIT 1");
    const locationId: string = rows[0].id;
    for (const weekday of t.weekdays) {
      await tx.query(
        `INSERT INTO availability_rules (tenant_id, location_id, resource_id, weekday, start_time, end_time)
         VALUES ($1, $2, NULL, $3, $4, $5)`,
        [tenantId, locationId, weekday, t.start, t.end],
      );
    }
    const staff = await tx.query(
      `INSERT INTO resources (tenant_id, location_id, kind, name, sort_order) VALUES ($1, $2, 'staff', $3, 1) RETURNING id`,
      [tenantId, locationId, staffName],
    );
    for (const s of t.services) {
      const svc = await tx.query(
        `INSERT INTO services (tenant_id, location_id, name, name_en, description, description_en, resource_kind, duration_min, price)
         VALUES ($1, $2, $3, $4, $5, $6, 'staff', $7, $8) RETURNING id`,
        [tenantId, locationId, s.name, s.nameEn, s.description, s.descriptionEn, s.durationMin, s.price[currency]],
      );
      await tx.query("INSERT INTO service_resources (service_id, resource_id, tenant_id) VALUES ($1, $2, $3)", [
        svc.rows[0].id,
        staff.rows[0].id,
        tenantId,
      ]);
    }
  });
}
