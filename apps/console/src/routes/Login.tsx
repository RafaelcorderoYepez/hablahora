import { zodResolver } from "@hookform/resolvers/zod";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Button, Field, Input } from "@hablahora/ui";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { authClient } from "../auth-client.js";
import { AuthCard, FormMessage } from "../components/AuthCard.js";
import { useI18n } from "../i18n.js";

/** Solo caminos de la propia consola (nunca a otro sitio). */
export function safeRedirect(target: unknown): string {
  return typeof target === "string" && target.startsWith("/") && !target.startsWith("//") ? target : "/";
}

export function LoginPage({ redirect }: { redirect?: string }) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [failed, setFailed] = useState(false);
  const schema = z.object({
    email: z.email({ message: t.login.emailInvalid }),
    password: z.string().min(1, t.login.passwordRequired),
  });
  const form = useForm({ resolver: zodResolver(schema), defaultValues: { email: "", password: "" } });

  const submit = form.handleSubmit(async (values) => {
    setFailed(false);
    const { error } = await authClient.signIn.email(values);
    if (error) return setFailed(true);
    await queryClient.invalidateQueries();
    await navigate({ to: safeRedirect(redirect) });
  });

  const err = form.formState.errors;
  return (
    <AuthCard title={t.login.title}>
      <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
        {failed ? <FormMessage tone="error">{t.login.invalid}</FormMessage> : null}
        <Field id="email" label={t.login.email} error={err.email?.message}>
          <Input id="email" type="email" autoComplete="email" aria-invalid={!!err.email} {...form.register("email")} />
        </Field>
        <Field id="password" label={t.login.password} error={err.password?.message}>
          <Input id="password" type="password" autoComplete="current-password" aria-invalid={!!err.password} {...form.register("password")} />
        </Field>
        <Button type="submit" variant="brand" disabled={form.formState.isSubmitting}>
          {t.login.submit}
        </Button>
        <Link to="/recuperar" className="text-sm text-brand-text underline-offset-4 hover:underline">
          {t.login.forgot}
        </Link>
      </form>
    </AuthCard>
  );
}
