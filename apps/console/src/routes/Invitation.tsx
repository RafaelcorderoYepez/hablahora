import { zodResolver } from "@hookform/resolvers/zod";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Button, cn, Field, Input } from "@hablahora/ui";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { ApiError } from "../api.js";
import { authClient } from "../auth-client.js";
import { AuthCard, FormMessage } from "../components/AuthCard.js";
import { useI18n } from "../i18n.js";
import { invitationQuery, meQuery } from "../queries.js";

/** Aceptar una invitación: con la cuenta abierta, creando una cuenta nueva o ingresando. */
export function InvitationPage({ id }: { id: string }) {
  const { t } = useI18n();
  const invitation = useQuery(invitationQuery(id));
  const me = useQuery({ ...meQuery, throwOnError: false });

  if (invitation.isPending || me.isPending) return <AuthCard title={t.common.loading}>{null}</AuthCard>;
  if (invitation.isError) {
    const notFound = invitation.error instanceof ApiError && invitation.error.status === 404;
    return (
      <AuthCard title={notFound ? t.invitation.notFound : t.common.loadError}>
        {notFound ? null : <Button onClick={() => void invitation.refetch()}>{t.common.retry}</Button>}
      </AuthCard>
    );
  }
  const inv = invitation.data;
  const title = t.invitation.title(inv.organization);
  if (inv.status !== "pending") {
    return (
      <AuthCard title={title}>
        <FormMessage tone="error">{inv.status === "expired" ? t.invitation.expired : t.invitation.used}</FormMessage>
      </AuthCard>
    );
  }
  const role = inv.role === "merchant_admin" ? t.roles.admin : t.roles.member;
  const user = me.data?.user;
  return (
    <AuthCard title={title}>
      <p className="text-sm text-muted">{t.invitation.asRole(role)}</p>
      {user ? (
        user.email.toLowerCase() === inv.email.toLowerCase() ? (
          <AcceptButton id={id} organization={inv.organization} note={t.invitation.acceptAs(user.email)} />
        ) : (
          <FormMessage tone="error">{t.invitation.wrongAccount(inv.email)}</FormMessage>
        )
      ) : (
        <SignUpOrIn id={id} email={inv.email} organization={inv.organization} />
      )}
    </AuthCard>
  );
}

function useAccept(id: string, organization: string) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  return async () => {
    const { data, error } = await authClient.organization.acceptInvitation({ invitationId: id });
    if (error) return toast.error(t.common.genericError);
    // el negocio de la invitación pasa a ser el activo
    const orgId = (data as { member?: { organizationId?: string } })?.member?.organizationId;
    if (orgId) await authClient.organization.setActive({ organizationId: orgId });
    await queryClient.invalidateQueries();
    toast.success(t.invitation.accepted(organization));
    await navigate({ to: "/" });
  };
}

function AcceptButton({ id, organization, note }: { id: string; organization: string; note: string }) {
  const { t } = useI18n();
  const accept = useAccept(id, organization);
  const [busy, setBusy] = useState(false);
  return (
    <>
      <p className="text-sm">{note}</p>
      <Button
        variant="brand"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          await accept();
          setBusy(false);
        }}
      >
        {t.invitation.accept}
      </Button>
    </>
  );
}

function SignUpOrIn({ id, email, organization }: { id: string; email: string; organization: string }) {
  const { t, locale } = useI18n();
  const [mode, setMode] = useState<"signup" | "signin">("signup");
  const [failed, setFailed] = useState<string | null>(null);
  const accept = useAccept(id, organization);
  const schema = z
    .object({
      name: mode === "signup" ? z.string().trim().min(1, t.invitation.nameRequired) : z.string(),
      password: mode === "signup" ? z.string().min(10, t.reset.minLength) : z.string().min(1, t.login.passwordRequired),
    });
  const form = useForm({ resolver: zodResolver(schema), defaultValues: { name: "", password: "" } });

  const submit = form.handleSubmit(async ({ name, password }) => {
    setFailed(null);
    const { error } =
      mode === "signup"
        ? await authClient.signUp.email({ email, password, name, locale })
        : await authClient.signIn.email({ email, password });
    if (error) return setFailed(mode === "signup" ? t.common.genericError : t.login.invalid);
    await accept();
  });

  const errors = form.formState.errors;
  return (
    <>
      <div role="tablist" className="grid grid-cols-2 rounded-lg border border-line p-0.5 text-sm">
        {(["signup", "signin"] as const).map((m) => (
          <button
            key={m}
            type="button"
            role="tab"
            aria-selected={mode === m}
            onClick={() => {
              setMode(m);
              setFailed(null);
              form.clearErrors();
            }}
            className={cn("rounded-md px-3 py-1.5 font-semibold", mode === m ? "bg-ink text-bg" : "text-muted hover:text-ink")}
          >
            {m === "signup" ? t.invitation.createAccount : t.invitation.haveAccount}
          </button>
        ))}
      </div>
      <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
        {failed ? <FormMessage tone="error">{failed}</FormMessage> : null}
        <Field id="email" label={t.login.email}>
          <Input id="email" type="email" value={email} readOnly />
        </Field>
        {mode === "signup" ? (
          <Field id="name" label={t.invitation.name} error={errors.name?.message}>
            <Input id="name" autoComplete="name" aria-invalid={!!errors.name} {...form.register("name")} />
          </Field>
        ) : null}
        <Field
          id="password"
          label={mode === "signup" ? t.reset.password : t.login.password}
          hint={mode === "signup" ? t.reset.minLength : undefined}
          error={errors.password?.message}
        >
          <Input
            id="password"
            type="password"
            autoComplete={mode === "signup" ? "new-password" : "current-password"}
            aria-invalid={!!errors.password}
            {...form.register("password")}
          />
        </Field>
        <Button type="submit" variant="brand" disabled={form.formState.isSubmitting}>
          {t.invitation.accept}
        </Button>
      </form>
    </>
  );
}
