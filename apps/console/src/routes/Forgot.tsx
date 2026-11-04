import { zodResolver } from "@hookform/resolvers/zod";
import { Link } from "@tanstack/react-router";
import { Button, Field, Input } from "@hablahora/ui";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { authClient } from "../auth-client.js";
import { AuthCard, FormMessage } from "../components/AuthCard.js";
import { useI18n } from "../i18n.js";

export function ForgotPage() {
  const { t } = useI18n();
  const [sent, setSent] = useState(false);
  const form = useForm({
    resolver: zodResolver(z.object({ email: z.email({ message: t.login.emailInvalid }) })),
    defaultValues: { email: "" },
  });
  const submit = form.handleSubmit(async ({ email }) => {
    // la respuesta es la misma exista o no la cuenta: no revela quién tiene cuenta
    await authClient.requestPasswordReset({ email, redirectTo: `${window.location.origin}/restablecer` });
    setSent(true);
  });
  return (
    <AuthCard title={t.forgot.title}>
      {sent ? (
        <FormMessage tone="success">{t.forgot.sent}</FormMessage>
      ) : (
        <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
          <p className="text-sm text-muted">{t.forgot.body}</p>
          <Field id="email" label={t.login.email} error={form.formState.errors.email?.message}>
            <Input id="email" type="email" autoComplete="email" aria-invalid={!!form.formState.errors.email} {...form.register("email")} />
          </Field>
          <Button type="submit" variant="brand" disabled={form.formState.isSubmitting}>
            {t.forgot.submit}
          </Button>
        </form>
      )}
      <Link to="/ingresar" className="text-sm text-brand-text underline-offset-4 hover:underline">
        {t.forgot.back}
      </Link>
    </AuthCard>
  );
}
