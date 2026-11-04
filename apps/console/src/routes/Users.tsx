import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge, Button, ConfirmDialog, Field, Input, Select } from "@hablahora/ui";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { authClient, authErrorCode } from "../auth-client.js";
import { PageHeader } from "../components/AppShell.js";
import { formatDate, useI18n, type Role } from "../i18n.js";
import { meQuery, organizationQuery } from "../queries.js";

type InviteRole = "admin" | "member";

/** Usuarios del negocio: miembros, invitaciones y roles (sobre Better Auth). */
export function UsersPage() {
  const { t, locale } = useI18n();
  const me = useQuery(meQuery).data!;
  const business = me.business!;
  const orgId = business.organizationId;
  const isAdmin = business.role === "merchant_admin";
  // suspendido: solo lectura (el aviso de la consola ya lo explica)
  const canEdit = isAdmin && business.status === "active";
  const org = useQuery(organizationQuery(orgId));
  const queryClient = useQueryClient();
  const [removing, setRemoving] = useState<{ id: string; name: string } | null>(null);

  /** Ejecuta una acción de Better Auth y muestra el resultado en el idioma de la consola. */
  const action = useMutation({
    mutationFn: async (run: () => Promise<{ error: { code?: string; status?: number } | null }>) => {
      const { error } = await run();
      if (error) throw new Error(authErrorCode(error));
    },
    onError: (err) => toast.error(t.users.errors[err.message] ?? t.common.genericError),
    onSettled: () => queryClient.invalidateQueries({ queryKey: organizationQuery(orgId).queryKey }),
  });
  const run = (fn: () => Promise<{ error: { code?: string; status?: number } | null }>, success: string) =>
    action.mutate(fn, { onSuccess: () => toast.success(success) });

  if (org.isPending) return <p className="text-muted">{t.common.loading}</p>;
  if (org.isError) {
    return (
      <div className="flex items-center gap-3">
        <p className="text-danger">{t.common.loadError}</p>
        <Button variant="outline" size="sm" onClick={() => void org.refetch()}>
          {t.common.retry}
        </Button>
      </div>
    );
  }

  const members = org.data.members;
  const invitations = org.data.invitations.filter((i) => i.status === "pending");

  return (
    <>
      <PageHeader title={t.users.title} subtitle={t.users.subtitle} />
      {!isAdmin ? <p className="mb-6 rounded-lg bg-info-bg px-4 py-3 text-sm text-info">{t.users.readOnly}</p> : null}

      <section aria-labelledby="members-title" className="flex flex-col gap-3">
        <h2 id="members-title" className="text-lg font-semibold">
          {t.users.members}
        </h2>
        <ul className="flex flex-col divide-y divide-line rounded-2xl border border-line bg-surface">
          {members.map((m) => {
            const role = (m.role.split(",")[0] as Role) ?? "member";
            const self = m.userId === me.user.id;
            return (
              <li key={m.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1 basis-48">
                  <p className="flex items-center gap-2 font-semibold">
                    <span className="truncate">{m.user.name}</span>
                    {self ? <Badge tone="info">{t.users.you}</Badge> : null}
                  </p>
                  <p className="truncate text-sm text-muted">{m.user.email}</p>
                </div>
                {canEdit && role !== "owner" && !self ? (
                  <>
                    <label htmlFor={`role-${m.id}`} className="sr-only">
                      {t.users.role}: {m.user.name}
                    </label>
                    <Select
                      id={`role-${m.id}`}
                      className="w-auto"
                      value={role}
                      disabled={action.isPending}
                      onChange={(e) =>
                        run(
                          () => authClient.organization.updateMemberRole({ memberId: m.id, role: e.target.value as InviteRole, organizationId: orgId }),
                          t.users.roleChanged,
                        )
                      }
                    >
                      <option value="admin">{t.roles.admin}</option>
                      <option value="member">{t.roles.member}</option>
                    </Select>
                    <Button variant="ghost" size="sm" onClick={() => setRemoving({ id: m.id, name: m.user.name })}>
                      {t.users.remove}
                    </Button>
                  </>
                ) : (
                  <Badge tone={role === "member" ? "neutral" : "info"}>{t.roles[role] ?? role}</Badge>
                )}
              </li>
            );
          })}
        </ul>
      </section>

      {canEdit ? <InviteForm organizationId={orgId} /> : null}

      {invitations.length ? (
        <section aria-labelledby="pending-title" className="mt-10 flex flex-col gap-3">
          <h2 id="pending-title" className="text-lg font-semibold">
            {t.users.pending}
          </h2>
          <ul className="flex flex-col divide-y divide-line rounded-2xl border border-line bg-surface">
            {invitations.map((inv) => (
              <li key={inv.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1 basis-48">
                  <p className="truncate font-semibold">{inv.email}</p>
                  <p className="text-sm text-muted">
                    {t.roles[(inv.role as Role) ?? "member"]} · {t.users.expires(formatDate(inv.expiresAt, locale))}
                  </p>
                </div>
                {canEdit ? (
                  <>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={action.isPending}
                      onClick={() =>
                        run(
                          () =>
                            authClient.organization.inviteMember({
                              email: inv.email,
                              role: (inv.role as InviteRole) ?? "member",
                              organizationId: orgId,
                              resend: true,
                            }),
                          t.users.resent,
                        )
                      }
                    >
                      {t.users.resend}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={action.isPending}
                      onClick={() => run(() => authClient.organization.cancelInvitation({ invitationId: inv.id }), t.users.cancelled)}
                    >
                      {t.users.cancelInvite}
                    </Button>
                  </>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={removing ? t.users.removeTitle(removing.name) : ""}
        description={t.users.removeBody(business.name)}
        confirmLabel={t.users.remove}
        cancelLabel={t.common.cancel}
        onConfirm={() => {
          if (removing) run(() => authClient.organization.removeMember({ memberIdOrEmail: removing.id, organizationId: orgId }), t.users.removed);
          setRemoving(null);
        }}
      />
    </>
  );
}

function InviteForm({ organizationId }: { organizationId: string }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const schema = z.object({ email: z.email({ message: t.login.emailInvalid }), role: z.enum(["admin", "member"]) });
  const form = useForm({ resolver: zodResolver(schema), defaultValues: { email: "", role: "member" as InviteRole } });

  const submit = form.handleSubmit(async ({ email, role }) => {
    const { error } = await authClient.organization.inviteMember({ email, role, organizationId });
    if (error) return void toast.error(t.users.errors[authErrorCode(error)] ?? t.common.genericError);
    toast.success(t.users.invited(email));
    form.reset();
    await queryClient.invalidateQueries({ queryKey: organizationQuery(organizationId).queryKey });
  });

  const errors = form.formState.errors;
  return (
    <section aria-labelledby="invite-title" className="mt-10 flex flex-col gap-3">
      <div>
        <h2 id="invite-title" className="text-lg font-semibold">
          {t.users.inviteTitle}
        </h2>
        <p className="text-sm text-muted">{t.users.inviteBody}</p>
      </div>
      <form onSubmit={submit} noValidate className="flex flex-col gap-4 rounded-2xl border border-line bg-surface p-4 sm:flex-row sm:items-start">
        <Field id="invite-email" label={t.users.inviteEmail} error={errors.email?.message} className="flex-1">
          <Input id="invite-email" type="email" autoComplete="off" aria-invalid={!!errors.email} {...form.register("email")} />
        </Field>
        <Field id="invite-role" label={t.users.inviteRole} hint={t.users.roleHelp} className="sm:w-64">
          <Select id="invite-role" {...form.register("role")}>
            <option value="member">{t.roles.member}</option>
            <option value="admin">{t.roles.admin}</option>
          </Select>
        </Field>
        <Button type="submit" variant="brand" className="sm:mt-7" disabled={form.formState.isSubmitting}>
          {t.users.inviteSubmit}
        </Button>
      </form>
    </section>
  );
}
