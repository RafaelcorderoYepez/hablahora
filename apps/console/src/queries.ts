import type {
  BookingList,
  Business,
  ConversationDetail,
  ConversationPage,
  CustomerSearchResult,
  DayAgenda,
  HandoffCount,
  Metrics,
  Plan,
  PlatformBusiness,
  PlatformHealth,
  PlatformOverview,
  PlatformSettings,
  PlatformUsage,
  PlatformUser,
  SupportLogPage,
  StaffAvailability,
  Closure,
  Hours,
  InvitationInfo,
  Policies,
  Readiness,
  Service,
  Staff,
  WebChatInfo,
} from "@hablahora/contracts";
import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import { api } from "./api.js";
import { authClient } from "./auth-client.js";

export interface Me {
  user: { id: string; name: string; email: string; locale: "es" | "en" | null };
  platformAdmin: boolean;
  business: {
    tenantId: string;
    organizationId: string;
    name: string;
    role: "merchant_admin" | "merchant_staff";
    status: "active" | "suspended" | "closed";
  } | null;
}

export const meQuery = queryOptions({
  queryKey: ["me"],
  queryFn: () => api<Me>("/api/me"),
  staleTime: 30_000,
  retry: false,
});

export const readinessQuery = queryOptions({
  queryKey: ["readiness"],
  queryFn: () => api<Readiness>("/api/merchant/readiness"),
});

export const invitationQuery = (id: string) =>
  queryOptions({
    queryKey: ["invitation", id],
    queryFn: () => api<InvitationInfo>(`/api/invitations/${encodeURIComponent(id)}`),
    retry: false,
  });

/** Miembros e invitaciones del negocio (Better Auth). */
export const organizationQuery = (organizationId: string) =>
  queryOptions({
    queryKey: ["organization", organizationId],
    queryFn: async () => {
      const { data, error } = await authClient.organization.getFullOrganization({ query: { organizationId } });
      if (error || !data) throw new Error(error?.message ?? "organización");
      return data;
    },
  });

export const organizationsQuery = queryOptions({
  queryKey: ["organizations"],
  queryFn: async () => {
    const { data, error } = await authClient.organization.list();
    if (error) throw new Error(error.message);
    return data ?? [];
  },
});

// ---------- configuración del negocio ----------

export const businessQuery = queryOptions({ queryKey: ["business"], queryFn: () => api<Business>("/api/merchant/business") });
export const servicesQuery = queryOptions({ queryKey: ["services"], queryFn: () => api<Service[]>("/api/merchant/services") });
export const staffQuery = queryOptions({ queryKey: ["staff"], queryFn: () => api<Staff[]>("/api/merchant/staff") });
export const hoursQuery = queryOptions({ queryKey: ["hours"], queryFn: () => api<Hours>("/api/merchant/hours") });
export const closuresQuery = queryOptions({ queryKey: ["closures"], queryFn: () => api<Closure[]>("/api/merchant/closures") });
export const policiesQuery = queryOptions({ queryKey: ["policies"], queryFn: () => api<Policies>("/api/merchant/policies") });
export const webChatQuery = queryOptions({ queryKey: ["web-chat"], queryFn: () => api<WebChatInfo>("/api/merchant/web-chat") });

// ---------- agenda y reservas ----------

export const agendaQuery = (date: string) =>
  queryOptions({ queryKey: ["agenda", date], queryFn: () => api<DayAgenda>(`/api/merchant/agenda?date=${date}`) });

export interface BookingFilters {
  from: string;
  to: string;
  status?: string;
  staffId?: string;
  q?: string;
}

export const bookingsQuery = (f: BookingFilters) =>
  queryOptions({
    queryKey: ["bookings", f],
    queryFn: () => api<BookingList>(`/api/merchant/bookings?${params({ ...f })}`),
  });

/** Horas libres para el equipo (al mover, `bookingId` cuenta su propio horario como libre). */
export const availabilityQuery = (q: { serviceId: string; date: string; staffId?: string; bookingId?: string }) =>
  queryOptions({
    queryKey: ["availability", q],
    queryFn: () => api<StaffAvailability>(`/api/merchant/availability?${params(q)}`),
    staleTime: 0,
  });

export const customersQuery = (q: string) =>
  queryOptions({
    queryKey: ["customers", q],
    queryFn: () => api<CustomerSearchResult>(`/api/merchant/customers?${params({ q })}`),
    enabled: q.trim().length >= 2,
  });

// ---------- conversaciones y paso a humano ----------

export const conversationsQuery = (handoff: boolean) =>
  infiniteQueryOptions({
    queryKey: ["conversations", { handoff }],
    queryFn: ({ pageParam }) =>
      api<ConversationPage>(`/api/merchant/conversations?${params({ handoff: handoff ? "true" : undefined, cursor: pageParam })}`),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

/** Con la conversación abierta se actualiza cada 5 s (mensajes nuevos del cliente). */
export const conversationQuery = (id: string) =>
  queryOptions({
    queryKey: ["conversation", id],
    queryFn: () => api<ConversationDetail>(`/api/merchant/conversations/${id}`),
    refetchInterval: 5000,
  });

/** Contador del menú: conversaciones que esperan al equipo. */
export const handoffCountQuery = queryOptions({
  queryKey: ["handoff-count"],
  queryFn: () => api<HandoffCount>("/api/merchant/handoff/count"),
  refetchInterval: 30_000,
});

export const metricsQuery = (from: string, to: string) =>
  queryOptions({ queryKey: ["metrics", from, to], queryFn: () => api<Metrics>(`/api/merchant/metrics?${params({ from, to })}`) });

// ---------- plataforma (consola del owner) ----------

export const platformBusinessesQuery = queryOptions({
  queryKey: ["platform", "businesses"],
  queryFn: () => api<PlatformBusiness[]>("/api/platform/businesses"),
});
export const platformPlansQuery = queryOptions({ queryKey: ["platform", "plans"], queryFn: () => api<Plan[]>("/api/platform/plans") });
export const platformSettingsQuery = queryOptions({
  queryKey: ["platform", "settings"],
  queryFn: () => api<PlatformSettings>("/api/platform/settings"),
});
export const platformOverviewQuery = (days: number) =>
  queryOptions({ queryKey: ["platform", "overview", days], queryFn: () => api<PlatformOverview>(`/api/platform/overview?days=${days}`) });
export const platformUsageQuery = (month: string) =>
  queryOptions({ queryKey: ["platform", "usage", month], queryFn: () => api<PlatformUsage>(`/api/platform/usage?month=${month}`) });
export const platformHealthQuery = queryOptions({
  queryKey: ["platform", "health"],
  queryFn: () => api<PlatformHealth>("/api/platform/health"),
  refetchInterval: 60_000,
});
export const supportLogQuery = (businessId?: string) =>
  queryOptions({
    queryKey: ["platform", "support-log", businessId ?? null],
    queryFn: () => api<SupportLogPage>(`/api/platform/support/log?${params({ limit: "100", businessId })}`),
  });
export const platformUsersQuery = queryOptions({ queryKey: ["platform", "users"], queryFn: () => api<PlatformUser[]>("/api/platform/users") });

/** Querystring sin los valores vacíos. */
function params(values: Record<string, string | undefined>): string {
  return new URLSearchParams(Object.entries(values).filter((e): e is [string, string] => !!e[1])).toString();
}

/** Escritura a la API desde la consola (PATCH/PUT/POST/DELETE con JSON). */
export const write = <T>(method: "PATCH" | "PUT" | "POST" | "DELETE", path: string, json?: unknown) =>
  api<T>(path, { method, ...(json !== undefined ? { json } : {}) });
