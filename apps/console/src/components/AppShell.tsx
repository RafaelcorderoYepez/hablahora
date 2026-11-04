import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, Outlet, useNavigate } from "@tanstack/react-router";
import { Button, Drawer, Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger, BrandWordmark } from "@hablahora/ui";
import {
  Bot,
  Building2,
  CalendarClock,
  CalendarDays,
  ChartColumn,
  Activity,
  Check,
  ChevronDown,
  Coins,
  House,
  Layers,
  LayoutDashboard,
  LifeBuoy,
  ListChecks,
  Menu as MenuIcon,
  MessageCircle,
  MessagesSquare,
  Scale,
  Scissors,
  Settings,
  ShieldCheck,
  Store,
  UserRound,
  Users,
} from "lucide-react";
import { useEffect, useState } from "react";
import { authClient } from "../auth-client.js";
import { useI18n, type Locale, type Messages } from "../i18n.js";
import { handoffCountQuery, meQuery, organizationsQuery } from "../queries.js";

const NAV = [
  { to: "/", key: "home", icon: House },
  { to: "/agenda", key: "agenda", icon: CalendarDays },
  { to: "/reservas", key: "bookings", icon: ListChecks },
  { to: "/conversaciones", key: "conversations", icon: MessagesSquare },
  { to: "/metricas", key: "metrics", icon: ChartColumn },
  { to: "/negocio", key: "business", icon: Building2 },
  { to: "/servicios", key: "services", icon: Scissors },
  { to: "/equipo", key: "staff", icon: UserRound },
  { to: "/horario", key: "hours", icon: CalendarClock },
  { to: "/politicas", key: "policies", icon: Scale },
  { to: "/agente", key: "agent", icon: Bot },
  { to: "/chat-web", key: "webChat", icon: MessageCircle },
  { to: "/usuarios", key: "users", icon: Users },
] as const satisfies readonly { to: string; key: keyof Messages["nav"]; icon: unknown }[];

const PLATFORM_NAV = [
  { to: "/plataforma", key: "overview", icon: LayoutDashboard },
  { to: "/plataforma/negocios", key: "businesses", icon: Store },
  { to: "/plataforma/uso", key: "usage", icon: Coins },
  { to: "/plataforma/salud", key: "health", icon: Activity },
  { to: "/plataforma/soporte", key: "support", icon: LifeBuoy },
  { to: "/plataforma/planes", key: "plans", icon: Layers },
  { to: "/plataforma/configuracion", key: "settings", icon: Settings },
  { to: "/plataforma/usuarios", key: "users", icon: ShieldCheck },
] as const satisfies readonly { to: string; key: keyof Messages["platform"]["nav"]; icon: unknown }[];

export type ShellVariant = "business" | "platform";

function NavLinks({ variant, onNavigate }: { variant: ShellVariant; onNavigate?: () => void }) {
  const { t } = useI18n();
  // conversaciones que esperan al equipo (se actualiza cada 30 s; la plataforma no tiene negocio)
  const waiting = useQuery({ ...handoffCountQuery, enabled: variant === "business" }).data?.count ?? 0;
  const items =
    variant === "platform"
      ? PLATFORM_NAV.map((n) => ({ ...n, label: t.platform.nav[n.key] }))
      : NAV.map((n) => ({ ...n, label: t.nav[n.key] }));
  return (
    <nav aria-label={t.common.menu} className="flex flex-col gap-0.5 px-3">
      {items.map(({ to, key, label, icon: Icon }) => (
        <Link
          key={to}
          to={to}
          onClick={onNavigate}
          activeOptions={{ exact: to === "/" || to === "/plataforma" }}
          className="flex items-center gap-3 rounded-lg px-3 py-2 text-[0.9375rem] text-muted hover:bg-bg hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
          activeProps={{ className: "bg-bg font-semibold text-ink", "aria-current": "page" }}
        >
          <Icon className="h-[18px] w-[18px]" aria-hidden="true" />
          <span className="flex-1">{label}</span>
          {key === "conversations" && waiting > 0 ? (
            <span className="rounded-full bg-brand px-1.5 text-xs font-semibold text-white tabular-nums" aria-label={`${waiting} ${t.inbox.waiting}`}>
              {waiting}
            </span>
          ) : null}
        </Link>
      ))}
    </nav>
  );
}

/**
 * Consola con sesión: menú lateral (cajón en el teléfono) y menú del usuario.
 * La del negocio y la de la plataforma comparten esta estructura con otras secciones.
 */
export function AppShell({ variant = "business" }: { variant?: ShellVariant }) {
  const { t, locale, setLocale } = useI18n();
  const me = useQuery(meQuery).data!;
  const [open, setOpen] = useState(false);

  // el idioma guardado en la cuenta manda
  useEffect(() => {
    if (me.user.locale && me.user.locale !== locale) setLocale(me.user.locale);
    // solo al cargar la cuenta
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me.user.locale]);

  return (
    <div className="flex min-h-dvh bg-bg text-ink">
      <aside className="hidden w-60 flex-none flex-col gap-6 border-r border-line bg-surface py-5 md:flex">
        <BrandWordmark className="px-6 text-xl text-ink" />
        <NavLinks variant={variant} />
      </aside>
      <Drawer open={open} onOpenChange={setOpen} title={t.common.menu}>
        <div className="flex flex-col gap-6 py-5">
          <BrandWordmark className="px-6 text-xl text-ink" />
          <NavLinks variant={variant} onNavigate={() => setOpen(false)} />
        </div>
      </Drawer>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b border-line bg-surface px-4 py-3 pt-[max(0.75rem,env(safe-area-inset-top))] md:px-8">
          <Button variant="ghost" size="icon" className="md:hidden" aria-label={t.common.menu} onClick={() => setOpen(true)}>
            <MenuIcon className="h-5 w-5" aria-hidden="true" />
          </Button>
          <p className="min-w-0 flex-1 truncate font-semibold">{variant === "platform" ? t.platform.title : me.business?.name}</p>
          <UserMenu locale={locale} variant={variant} />
        </header>
        <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8 md:px-8">
          {variant === "business" && me.business?.status === "closed" ? (
            <div className="flex flex-col gap-2 rounded-2xl border border-line bg-surface p-6">
              <h1 className="text-2xl font-display font-bold">{t.platform.businessClosedTitle}</h1>
              <p className="text-muted">{t.platform.businessClosedBody}</p>
            </div>
          ) : (
            <>
              {variant === "business" && me.business?.status === "suspended" ? (
                <p role="status" className="mb-6 rounded-lg bg-warning-bg px-4 py-3 text-sm font-semibold text-warning">
                  {t.platform.businessSuspended}
                </p>
              ) : null}
              <Outlet />
            </>
          )}
        </main>
      </div>
    </div>
  );
}

function UserMenu({ locale, variant }: { locale: Locale; variant: ShellVariant }) {
  const { t, setLocale } = useI18n();
  const me = useQuery(meQuery).data!;
  const orgs = useQuery(organizationsQuery);
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const changeLocale = async (l: Locale) => {
    setLocale(l);
    await authClient.updateUser({ locale: l });
    await queryClient.invalidateQueries({ queryKey: meQuery.queryKey });
  };
  const logout = async () => {
    await authClient.signOut();
    queryClient.clear();
    await navigate({ to: "/ingresar" });
  };

  return (
    <Menu>
      <MenuTrigger asChild>
        <Button variant="ghost" className="gap-2 px-2.5" aria-label={me.user.name}>
          <span aria-hidden="true" className="grid h-8 w-8 place-items-center rounded-full bg-ink text-sm font-semibold text-bg">
            {me.user.name.slice(0, 1).toUpperCase()}
          </span>
          <span className="hidden max-w-40 truncate sm:inline">{me.user.name}</span>
          <ChevronDown className="h-4 w-4 text-muted" aria-hidden="true" />
        </Button>
      </MenuTrigger>
      <MenuContent>
        <div className="px-2.5 py-1.5">
          <p className="truncate text-sm font-semibold">{me.user.name}</p>
          <p className="truncate text-xs text-muted">{me.user.email}</p>
        </div>
        <MenuSeparator />
        <MenuLabel>{t.menu.language}</MenuLabel>
        {(["es", "en"] as const).map((l) => (
          <MenuItem key={l} active={locale === l} onSelect={() => void changeLocale(l)}>
            <span className="w-4">{locale === l ? <Check className="h-4 w-4" aria-hidden="true" /> : null}</span>
            {l === "es" ? "Español" : "English"}
          </MenuItem>
        ))}
        {variant === "business" && (orgs.data?.length ?? 0) > 1 ? (
          <>
            <MenuSeparator />
            <MenuItem onSelect={() => void navigate({ to: "/elegir-negocio" })}>{t.menu.switchBusiness}</MenuItem>
          </>
        ) : null}
        {/* el administrador de plataforma que también es miembro de un negocio pasa de una consola a la otra */}
        {variant === "business" && me.platformAdmin ? (
          <>
            <MenuSeparator />
            <MenuItem onSelect={() => void navigate({ to: "/plataforma" })}>{t.platform.toPlatform}</MenuItem>
          </>
        ) : null}
        {variant === "platform" && (orgs.data?.length ?? 0) > 0 ? (
          <>
            <MenuSeparator />
            <MenuItem onSelect={() => void navigate({ to: "/elegir-negocio" })}>{t.platform.toBusiness}</MenuItem>
          </>
        ) : null}
        <MenuSeparator />
        <MenuItem onSelect={() => void logout()}>{t.menu.logout}</MenuItem>
      </MenuContent>
    </Menu>
  );
}

/** Encabezado de cada sección de la consola. */
export function PageHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="mb-8 flex flex-col gap-1.5">
      <h1 className="text-3xl font-display font-bold text-balance">{title}</h1>
      {subtitle ? <p className="text-muted">{subtitle}</p> : null}
    </div>
  );
}
