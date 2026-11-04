import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import type { ConversationContext } from "../booking/service.js";
import { normalizeEmail } from "../booking/service.js";
import { withTenant, type Db } from "../db/tenant.js";
import type { EmailSender } from "../email/sender.js";

export interface EmailCodeOptions {
  db: Db;
  email: EmailSender;
  clock?: () => Date;
  /** vida del código (por defecto 10 minutos) */
  ttlMinutes?: number;
  /** intentos por código (por defecto 5) */
  maxAttempts?: number;
  /** envíos por hora, por conversación y por email (por defecto 3) */
  maxSendsPerHour?: number;
}

export type RequestCodeResult =
  | { ok: true; email: string }
  | { ok: false; reason: "not_available" | "invalid_email" | "rate_limited" };

export type VerifyCodeResult =
  | { ok: true; email: string }
  | {
      ok: false;
      reason: "not_available" | "no_pending_code" | "expired" | "too_many_attempts" | "wrong_code";
      attemptsLeft?: number;
    };

/**
 * Verificación del email del cliente del chat web con un código de 6 dígitos.
 * Reservar no lo pide; sí ver, mover o cancelar reservas hechas en otra sesión.
 * El código no se guarda: solo su hash con sal. Lo compara el backend; el
 * modelo solo pasa lo que el cliente escribió.
 */
export class EmailCodeService {
  private clock: () => Date;
  private ttlMs: number;
  private maxAttempts: number;
  private maxSends: number;

  constructor(private opts: EmailCodeOptions) {
    this.clock = opts.clock ?? (() => new Date());
    this.ttlMs = (opts.ttlMinutes ?? 10) * 60_000;
    this.maxAttempts = opts.maxAttempts ?? 5;
    this.maxSends = opts.maxSendsPerHour ?? 3;
  }

  async requestCode(ctx: ConversationContext, rawEmail: string): Promise<RequestCodeResult> {
    if (ctx.channel !== "web" || !ctx.conversationId) return { ok: false, reason: "not_available" };
    const email = normalizeEmail(rawEmail);
    if (!email) return { ok: false, reason: "invalid_email" };
    const conversationId = ctx.conversationId;
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    const salt = randomBytes(16).toString("hex");
    const now = this.clock();

    const sent = await withTenant(this.opts.db, ctx.tenantId, async (tx) => {
      // límites: que nadie use el chat para llenarle el correo a otra persona
      const hourAgo = new Date(now.getTime() - 3_600_000);
      const { rows } = await tx.query(
        `SELECT count(*) FILTER (WHERE conversation_id = $1)::int AS by_conv,
                count(*) FILTER (WHERE email = $2)::int AS by_email
           FROM email_verifications
          WHERE created_at > $3 AND (conversation_id = $1 OR email = $2)`,
        [conversationId, email, hourAgo],
      );
      if (rows[0].by_conv >= this.maxSends || rows[0].by_email >= this.maxSends) return null;

      // un código nuevo reemplaza a los anteriores de esta conversación
      await tx.query(
        "UPDATE email_verifications SET consumed_at = $2 WHERE conversation_id = $1 AND consumed_at IS NULL",
        [conversationId, now],
      );
      await tx.query(
        `INSERT INTO email_verifications (tenant_id, conversation_id, email, code_hash, salt, expires_at, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [ctx.tenantId, conversationId, email, hash(salt, code), salt, new Date(now.getTime() + this.ttlMs), now],
      );
      // el correo en el idioma de la conversación (o el de la sucursal)
      const biz = await tx.query(
        `SELECT t.name, coalesce(c.locale, l.default_locale) AS locale
           FROM conversations c JOIN locations l ON l.id = c.location_id JOIN tenants t ON t.id = l.tenant_id
          WHERE c.id = $1`,
        [conversationId],
      );
      return { business: biz.rows[0]?.name as string, locale: (biz.rows[0]?.locale as string) ?? "es" };
    });
    if (!sent) return { ok: false, reason: "rate_limited" };

    const minutes = this.ttlMs / 60_000;
    await this.opts.email.send(
      sent.locale.startsWith("en")
        ? {
            to: email,
            subject: `Your ${sent.business} code: ${code}`,
            text: `Your code to manage your bookings at ${sent.business} is ${code}. It expires in ${minutes} minutes.\nIf you didn't ask for it, ignore this email.`,
          }
        : {
            to: email,
            subject: `Tu código de ${sent.business}: ${code}`,
            text: `Tu código para gestionar tus reservas en ${sent.business} es ${code}. Vence en ${minutes} minutos.\nSi no lo pediste, ignora este correo.`,
          },
    );
    return { ok: true, email };
  }

  /** Si el código es correcto, la conversación queda con ese email verificado. */
  async verifyCode(ctx: ConversationContext, rawCode: string): Promise<VerifyCodeResult> {
    if (ctx.channel !== "web" || !ctx.conversationId) return { ok: false, reason: "not_available" };
    const code = rawCode.replace(/\D/g, "");
    const now = this.clock();

    return withTenant(this.opts.db, ctx.tenantId, async (tx) => {
      const { rows } = await tx.query(
        `SELECT * FROM email_verifications
          WHERE conversation_id = $1 AND consumed_at IS NULL
          ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
        [ctx.conversationId],
      );
      const v = rows[0];
      if (!v) return { ok: false, reason: "no_pending_code" };
      if (v.expires_at <= now) return { ok: false, reason: "expired" };
      if (v.attempts >= this.maxAttempts) return { ok: false, reason: "too_many_attempts" };

      if (!safeEqual(hash(v.salt, code), v.code_hash)) {
        await tx.query("UPDATE email_verifications SET attempts = attempts + 1 WHERE id = $1", [v.id]);
        const attemptsLeft = this.maxAttempts - v.attempts - 1;
        return attemptsLeft > 0
          ? { ok: false, reason: "wrong_code", attemptsLeft }
          : { ok: false, reason: "too_many_attempts" };
      }

      await tx.query("UPDATE email_verifications SET consumed_at = $2 WHERE id = $1", [v.id, now]);
      await tx.query("UPDATE conversations SET verified_email = $2, updated_at = $3 WHERE id = $1", [
        ctx.conversationId,
        v.email,
        now,
      ]);
      ctx.verifiedEmail = v.email; // las siguientes herramientas de esta conversación ya lo saben
      return { ok: true, email: v.email };
    });
  }
}

function hash(salt: string, code: string): string {
  return createHash("sha256").update(`${salt}:${code}`).digest("hex");
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  return x.length === y.length && timingSafeEqual(x, y);
}
