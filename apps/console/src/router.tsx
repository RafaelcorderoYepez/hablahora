import type { QueryClient } from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  isRedirect,
  Outlet,
  redirect,
  type RouterHistory,
} from "@tanstack/react-router";
import { ApiError } from "./api.js";
import { AppShell } from "./components/AppShell.js";
import { meQuery } from "./queries.js";
import { ChooseBusinessPage } from "./routes/ChooseBusiness.js";
import { ForgotPage } from "./routes/Forgot.js";
import { HomePage } from "./routes/Home.js";
import { InvitationPage } from "./routes/Invitation.js";
import { LoginPage } from "./routes/Login.js";
import { ResetPage } from "./routes/Reset.js";
import { AgendaPage } from "./routes/Agenda.js";
import { AgentPage } from "./routes/Agent.js";
import { BookingsPage, type BookingsSearch } from "./routes/Bookings.js";
import { ConversationPage } from "./routes/Conversation.js";
import { ConversationsPage } from "./routes/Conversations.js";
import { lazy, Suspense } from "react";
import { PlatformBusinessesPage } from "./routes/platform/Businesses.js";
import { PlatformHealthPage } from "./routes/platform/Health.js";
import { PlatformSupportPage } from "./routes/platform/Support.js";
import { PlatformUsagePage } from "./routes/platform/Usage.js";
import { PlatformPlansPage } from "./routes/platform/Plans.js";
import { PlatformSettingsPage } from "./routes/platform/Settings.js";
import { PlatformUsersPage } from "./routes/platform/Users.js";
import { OVERVIEW_PERIODS, PERIODS, type OverviewPeriod, type Period } from "./metrics-periods.js";

// Recharts pesa: las métricas se cargan solo al abrirlas
const MetricsPage = lazy(() => import("./routes/Metrics.js").then((m) => ({ default: m.MetricsPage })));
const PlatformOverviewPage = lazy(() => import("./routes/platform/Overview.js").then((m) => ({ default: m.PlatformOverviewPage })));
import { BusinessPage } from "./routes/Business.js";
import { HoursPage } from "./routes/Hours.js";
import { PoliciesPage } from "./routes/Policies.js";
import { ServicesPage } from "./routes/Services.js";
import { StaffPage } from "./routes/Staff.js";
import { UsersPage } from "./routes/Users.js";
import { WebChatPage } from "./routes/WebChat.js";

const rootRoute = createRootRouteWithContext<{ queryClient: QueryClient }>()({ component: Outlet });

// ---------- sin sesión ----------

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/ingresar",
  validateSearch: (s: Record<string, unknown>): { redirect?: string } =>
    typeof s.redirect === "string" ? { redirect: s.redirect } : {},
  component: function Login() {
    const { redirect: target } = loginRoute.useSearch();
    return <LoginPage redirect={target} />;
  },
});

const forgotRoute = createRoute({ getParentRoute: () => rootRoute, path: "/recuperar", component: ForgotPage });

const resetRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/restablecer",
  validateSearch: (s: Record<string, unknown>): { token?: string; error?: string } => ({
    ...(typeof s.token === "string" ? { token: s.token } : {}),
    ...(typeof s.error === "string" ? { error: s.error } : {}),
  }),
  component: function Reset() {
    const { token, error } = resetRoute.useSearch();
    return <ResetPage token={token} error={error} />;
  },
});

const invitationRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/invitacion/$id",
  component: function Invitation() {
    const { id } = invitationRoute.useParams();
    return <InvitationPage id={id} />;
  },
});

// ---------- con sesión ----------

/** Sesión obligatoria; sin negocio activo, a la plataforma (si es su administrador) o a elegir uno. */
async function requireSession(queryClient: QueryClient, href: string, needBusiness: boolean) {
  try {
    const me = await queryClient.ensureQueryData(meQuery);
    if (needBusiness && !me.business) throw redirect({ to: me.platformAdmin ? "/plataforma" : "/elegir-negocio" });
    return { me };
  } catch (err) {
    if (isRedirect(err)) throw err;
    if (err instanceof ApiError && err.status === 401) throw redirect({ to: "/ingresar", search: { redirect: href } });
    throw err;
  }
}

const chooseRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/elegir-negocio",
  beforeLoad: ({ context, location }) => requireSession(context.queryClient, location.href, false),
  component: ChooseBusinessPage,
});

const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "app",
  beforeLoad: ({ context, location }) => requireSession(context.queryClient, location.href, true),
  component: AppShell,
});

// ---------- consola de la plataforma (owner) ----------

const platformRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "platform",
  beforeLoad: async ({ context, location }) => {
    const { me } = await requireSession(context.queryClient, location.href, false);
    if (!me.platformAdmin) throw redirect({ to: "/" });
    return { me };
  },
  component: function Platform() {
    return <AppShell variant="platform" />;
  },
});

const platformParent = () => platformRoute;
const platformOverviewRoute = createRoute({
  getParentRoute: platformParent,
  path: "/plataforma",
  validateSearch: (s: Record<string, unknown>): { dias?: OverviewPeriod } => {
    const n = Number(s.dias);
    return OVERVIEW_PERIODS.includes(n as OverviewPeriod) && n !== 30 ? { dias: n as OverviewPeriod } : {};
  },
  component: function Overview() {
    const { dias } = platformOverviewRoute.useSearch();
    return (
      <Suspense fallback={null}>
        <PlatformOverviewPage days={dias ?? 30} />
      </Suspense>
    );
  },
});

const platformUsageRoute = createRoute({
  getParentRoute: platformParent,
  path: "/plataforma/uso",
  validateSearch: (s: Record<string, unknown>): { mes?: string } => (typeof s.mes === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(s.mes) ? { mes: s.mes } : {}),
  component: function Usage() {
    const { mes } = platformUsageRoute.useSearch();
    return <PlatformUsagePage month={mes} />;
  },
});

const platformSupportRoute = createRoute({
  getParentRoute: platformParent,
  path: "/plataforma/soporte",
  validateSearch: (s: Record<string, unknown>): { negocio?: string } =>
    typeof s.negocio === "string" && /^[0-9a-f-]{36}$/i.test(s.negocio) ? { negocio: s.negocio } : {},
  component: function Support() {
    const { negocio } = platformSupportRoute.useSearch();
    return <PlatformSupportPage businessId={negocio} />;
  },
});

const platformRoutes = [
  platformOverviewRoute,
  createRoute({ getParentRoute: platformParent, path: "/plataforma/negocios", component: PlatformBusinessesPage }),
  platformUsageRoute,
  createRoute({ getParentRoute: platformParent, path: "/plataforma/salud", component: PlatformHealthPage }),
  platformSupportRoute,
  createRoute({ getParentRoute: platformParent, path: "/plataforma/planes", component: PlatformPlansPage }),
  createRoute({ getParentRoute: platformParent, path: "/plataforma/configuracion", component: PlatformSettingsPage }),
  createRoute({ getParentRoute: platformParent, path: "/plataforma/usuarios", component: PlatformUsersPage }),
] as const;

const parent = () => appRoute;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const text = (v: unknown, re?: RegExp) => (typeof v === "string" && v && (!re || re.test(v)) ? v : undefined);

const agendaRoute = createRoute({
  getParentRoute: parent,
  path: "/agenda",
  validateSearch: (s: Record<string, unknown>): { date?: string } => {
    const date = text(s.date, DATE);
    return date ? { date } : {};
  },
  component: function Agenda() {
    const { date } = agendaRoute.useSearch();
    return <AgendaPage date={date} />;
  },
});

const bookingsRoute = createRoute({
  getParentRoute: parent,
  path: "/reservas",
  validateSearch: (s: Record<string, unknown>): BookingsSearch =>
    Object.fromEntries(
      Object.entries({
        from: text(s.from, DATE),
        to: text(s.to, DATE),
        status: text(s.status, /^[a-z_]+$/),
        staffId: text(s.staffId, /^[0-9a-f-]{36}$/i),
        q: text(s.q),
      }).filter(([, v]) => v !== undefined),
    ),
  component: function Bookings() {
    return <BookingsPage search={bookingsRoute.useSearch()} />;
  },
});

const conversationsRoute = createRoute({
  getParentRoute: parent,
  path: "/conversaciones",
  validateSearch: (s: Record<string, unknown>): { espera?: true } => (s.espera === true || s.espera === "true" ? { espera: true } : {}),
  component: function Conversations() {
    const { espera } = conversationsRoute.useSearch();
    return <ConversationsPage waiting={!!espera} />;
  },
});

const conversationRoute = createRoute({
  getParentRoute: parent,
  path: "/conversaciones/$id",
  component: function Conversation() {
    const { id } = conversationRoute.useParams();
    return <ConversationPage key={id} id={id} />;
  },
});

const metricsRoute = createRoute({
  getParentRoute: parent,
  path: "/metricas",
  validateSearch: (s: Record<string, unknown>): { dias?: Period } => {
    const n = Number(s.dias);
    return PERIODS.includes(n as Period) && n !== 30 ? { dias: n as Period } : {};
  },
  component: function Metrics() {
    const { dias } = metricsRoute.useSearch();
    return (
      <Suspense fallback={null}>
        <MetricsPage period={dias ?? 30} />
      </Suspense>
    );
  },
});

const appRoutes = [
  createRoute({ getParentRoute: parent, path: "/", component: HomePage }),
  agendaRoute,
  bookingsRoute,
  conversationsRoute,
  conversationRoute,
  metricsRoute,
  createRoute({ getParentRoute: parent, path: "/usuarios", component: UsersPage }),
  createRoute({ getParentRoute: parent, path: "/negocio", component: BusinessPage }),
  createRoute({ getParentRoute: parent, path: "/servicios", component: ServicesPage }),
  createRoute({ getParentRoute: parent, path: "/equipo", component: StaffPage }),
  createRoute({ getParentRoute: parent, path: "/horario", component: HoursPage }),
  createRoute({ getParentRoute: parent, path: "/politicas", component: PoliciesPage }),
  createRoute({ getParentRoute: parent, path: "/agente", component: AgentPage }),
  createRoute({ getParentRoute: parent, path: "/chat-web", component: WebChatPage }),
] as const;

const routeTree = rootRoute.addChildren([
  loginRoute,
  forgotRoute,
  resetRoute,
  invitationRoute,
  chooseRoute,
  appRoute.addChildren(appRoutes),
  platformRoute.addChildren(platformRoutes),
]);

export function makeRouter(queryClient: QueryClient, history?: RouterHistory) {
  return createRouter({ routeTree, context: { queryClient }, history, defaultPreload: "intent" });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof makeRouter>;
  }
}
