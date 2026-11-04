import { useQuery } from "@tanstack/react-query";
import type { PlatformUser } from "@hablahora/contracts";
import { Badge, Button, ConfirmDialog, Field, Input } from "@hablahora/ui";
import { useState } from "react";
import { PageHeader } from "../../components/AppShell.js";
import { Card, Loaded } from "../../components/common.js";
import { useI18n } from "../../i18n.js";
import { meQuery, platformUsersQuery, write } from "../../queries.js";
import { usePlatformSave } from "./common.js";

/** Administradores de la plataforma: invitar y quitar acceso. */
export function PlatformUsersPage() {
  const { t } = useI18n();
  const p = t.platform;
  const me = useQuery(meQuery).data!;
  const users = useQuery(platformUsersQuery);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [removing, setRemoving] = useState<PlatformUser | null>(null);
  const invite = usePlatformSave(
    (body: { name: string; email: string }) => write<PlatformUser[]>("POST", "/api/platform/users", body),
    () => p.invited(email.trim()),
  );
  const remove = usePlatformSave((id: string) => write<PlatformUser[]>("DELETE", `/api/platform/users/${id}`), p.removed);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const next: Record<string, string> = {};
    if (!name.trim()) next.name = t.cfg.common.required;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) next.email = t.login.emailInvalid;
    setErrors(next);
    if (Object.keys(next).length) return;
    invite.mutate(
      { name: name.trim(), email: email.trim() },
      {
        onSuccess: () => {
          setName("");
          setEmail("");
        },
      },
    );
  };

  return (
    <>
      <PageHeader title={p.nav.users} subtitle={p.usersSubtitle} />
      <div className="flex flex-col gap-6">
        <Loaded query={users}>
          {(list) => (
            <ul className="flex flex-col divide-y divide-line rounded-2xl border border-line bg-surface">
              {list.map((u) => (
                <li key={u.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-2 font-semibold">
                      {u.name}
                      {u.id === me.user.id ? <Badge>{p.you}</Badge> : null}
                    </p>
                    <p className="truncate text-sm text-muted">{u.email}</p>
                  </div>
                  {u.id !== me.user.id && list.length > 1 ? (
                    <Button variant="ghost" size="sm" className="text-danger" onClick={() => setRemoving(u)}>
                      {p.remove}
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </Loaded>
        <Card title={p.invite}>
          <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field id="pu-name" label={p.inviteName} error={errors.name}>
                <Input id="pu-name" value={name} aria-invalid={!!errors.name} onChange={(e) => setName(e.target.value)} />
              </Field>
              <Field id="pu-email" label={p.inviteEmail} error={errors.email}>
                <Input id="pu-email" type="email" value={email} aria-invalid={!!errors.email} onChange={(e) => setEmail(e.target.value)} />
              </Field>
            </div>
            <Button type="submit" variant="brand" className="self-start" disabled={invite.isPending}>
              {p.invite}
            </Button>
          </form>
        </Card>
      </div>
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={removing ? p.removeTitle(removing.name) : ""}
        description={p.removeBody}
        confirmLabel={p.remove}
        cancelLabel={t.common.cancel}
        onConfirm={() => {
          if (removing) remove.mutate(removing.id);
          setRemoving(null);
        }}
      />
    </>
  );
}
