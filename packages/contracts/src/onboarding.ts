import { z } from "zod";

/** Lo que hace falta para que el chat del negocio pueda atender. */
export const ReadinessCheckKey = z.enum(["services", "hours", "web_chat_slug", "agent_knowledge"]);
export type ReadinessCheckKey = z.infer<typeof ReadinessCheckKey>;

export const Readiness = z.object({
  /** todos los obligatorios están completos */
  ready: z.boolean(),
  checks: z.array(
    z.object({
      key: ReadinessCheckKey,
      ok: z.boolean(),
      /** false: recomendado, no impide atender */
      required: z.boolean(),
    }),
  ),
});
export type Readiness = z.infer<typeof Readiness>;

/** GET /api/invitations/:id: lo que muestra la página de aceptar una invitación. */
export const InvitationInfo = z.object({
  organization: z.string(),
  email: z.string(),
  role: z.enum(["merchant_admin", "merchant_staff"]),
  status: z.enum(["pending", "expired", "accepted", "rejected", "canceled"]),
});
export type InvitationInfo = z.infer<typeof InvitationInfo>;
