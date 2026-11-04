import { zodResolver } from "@hookform/resolvers/zod";
import { Link } from "@tanstack/react-router";
import { Button, Field, Input } from "@hablahora/ui";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { authClient } from "../auth-client.js";
import { AuthCard, FormMessage } from "../components/AuthCard.js";
import { useI18n } from "../i18n.js";

/** Elegir contraseña: desde "recuperar" o desde la bienvenida de un negocio nuevo. */
export function ResetPage({ token, error }: { token?: string; error?: string }) {
  const { t } = useI18n();
  const [state, setState] = useState<"form" | "done" | "invalid">(token && !error ? "form" : "invalid");
  const schema = z
    .object({ password: z.string().min(10, t.reset.minLength), confirm: z.string() })
    .refine((v) => v.password === v.confirm, { message: t.reset.mismatch, path: ["confirm"] });
  const form = useForm({ resolver: zodResolver(schema), defaultValues: { password: "", confirm: "" } });

  const submit = form.handleSubmit(async ({ password }) => {
    const { error: err } = await authClient.resetPassword({ newPassword: password, token: token! });
    setState(err ? "invalid" : "done");
  });

  const errors = form.formState.errors;
  return (
    <AuthCard title={t.reset.title}>
      {state === "done" ? (
        <>
          <FormMessage tone="success">{t.reset.done}</FormMessage>
          <Link to="/ingresar" className="font-semibold text-brand-text underline-offset-4 hover:underline">
            {t.login.submit}
          </Link>
        </>
      ) : state === "invalid" ? (
        <>
          <FormMessage tone="error">{t.reset.invalidLink}</FormMessage>
          <Link to="/recuperar" className="font-semibold text-brand-text underline-offset-4 hover:underline">
            {t.reset.requestNew}
          </Link>
        </>
      ) : (
        <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
          <Field id="password" label={t.reset.password} hint={t.reset.minLength} error={errors.password?.message}>
            <Input id="password" type="password" autoComplete="new-password" aria-invalid={!!errors.password} {...form.register("password")} />
          </Field>
          <Field id="confirm" label={t.reset.confirm} error={errors.confirm?.message}>
            <Input id="confirm" type="password" autoComplete="new-password" aria-invalid={!!errors.confirm} {...form.register("confirm")} />
          </Field>
          <Button type="submit" variant="brand" disabled={form.formState.isSubmitting}>
            {t.reset.submit}
          </Button>
        </form>
      )}
    </AuthCard>
  );
}
