import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Button } from "@hablahora/ui";
import { ChevronRight } from "lucide-react";
import { authClient } from "../auth-client.js";
import { AuthCard } from "../components/AuthCard.js";
import { useI18n } from "../i18n.js";
import { meQuery, organizationsQuery } from "../queries.js";

/** Para quien pertenece a varios negocios (o a ninguno activo). */
export function ChooseBusinessPage() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const orgs = useQuery(organizationsQuery);
  const platformAdmin = useQuery(meQuery).data?.platformAdmin ?? false;

  const choose = async (organizationId: string) => {
    await authClient.organization.setActive({ organizationId });
    await queryClient.invalidateQueries();
    await navigate({ to: "/" });
  };
  const logout = async () => {
    await authClient.signOut();
    queryClient.clear();
    await navigate({ to: "/ingresar" });
  };

  return (
    <AuthCard title={t.choose.title}>
      {orgs.isPending ? (
        <p className="text-sm text-muted">{t.common.loading}</p>
      ) : orgs.data?.length ? (
        <ul className="flex flex-col gap-2">
          {orgs.data.map((o) => (
            <li key={o.id}>
              <button
                type="button"
                onClick={() => void choose(o.id)}
                className="flex w-full items-center justify-between rounded-lg border border-line px-4 py-3 text-left font-semibold hover:bg-surface focus-visible:outline-2 focus-visible:outline-accent"
              >
                {o.name}
                <ChevronRight className="h-4 w-4 text-muted" aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p>{t.choose.none}</p>
      )}
      {platformAdmin ? (
        <Button variant="brand" onClick={() => void navigate({ to: "/plataforma" })}>
          {t.platform.toPlatform}
        </Button>
      ) : null}
      <Button variant="outline" onClick={() => void logout()}>
        {t.menu.logout}
      </Button>
    </AuthCard>
  );
}
