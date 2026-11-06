// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addDays, todayIn } from "./agenda.js";
import { periodRange, percent } from "./routes/Metrics.js";
import { calls, ME_ADMIN, mockApi, renderAt, setupBrowser } from "./test-api.js";

const TZ = "America/New_York";
const BUSINESS = {
  name: "Salón Aurora",
  locationName: "Brickell",
  address: null,
  timezone: TZ,
  country: "US",
  currency: "USD",
  defaultLocale: "es",
  agentTone: "warm",
  agentInstructions: null,
  agentInstructionsEn: null,
  agentHandoff: null,
  agentHandoffEn: null,
  webChatSlug: "salon-aurora",
  chatEnabled: true,
  chatSettings: { palette: "rosa", accent: null, appearance: "auto", tint: false, texture: "none", welcome: { es: null, en: null } },
};

function metrics(url: URL) {
  const from = url.searchParams.get("from")!;
  return {
    from,
    to: url.searchParams.get("to")!,
    totals: { pending: 1, confirmed: 30, completed: 6, noShow: 3, cancelled: 10, booked: 40 },
    days: [{ date: from, pending: 1, confirmed: 30, completed: 6, noShow: 3, cancelled: 10 }],
    bySource: [
      { source: "web", count: 28 },
      { source: "staff", count: 12 },
    ],
    topServices: [{ id: "00000000-0000-4000-8000-000000000201", name: "Corte de mujer", count: 22 }],
    chat: { conversations: 50, withBooking: 28, handedOff: 4, medianTeamReplyMin: 75 },
    occupancy: [
      { staffId: "00000000-0000-4000-8000-000000000101", name: "Valeria", bookedMin: 5400, availableMin: 18000, ratio: 0.3 },
      { staffId: "00000000-0000-4000-8000-000000000103", name: "Diego", bookedMin: 0, availableMin: 0, ratio: null },
    ],
  };
}

function api() {
  mockApi({
    "GET /api/me": () => ME_ADMIN,
    "GET /api/merchant/readiness": () => ({ ready: true, checks: [] }),
    "GET /api/merchant/business": () => BUSINESS,
    "GET /api/merchant/handoff/count": () => ({ count: 0 }),
    "GET /api/merchant/metrics": (_b, url) => metrics(url),
    "GET /api/auth/organization/list": () => [],
  });
}

beforeEach(setupBrowser);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const asked = () => (fetch as unknown as { mock: { calls: [string][] } }).mock.calls.map(([u]) => String(u)).filter((u) => u.includes("/metrics"));

describe("métricas", () => {
  it("últimos 30 días por defecto: indicadores, chat, origen, servicios y ocupación", async () => {
    api();
    renderAt("/metricas");
    const today = todayIn(TZ);
    expect(await screen.findByText("Chats con reserva")).toBeTruthy();
    expect(asked()[0]).toContain(`from=${addDays(today, -29)}&to=${today}`);

    expect(screen.getByText("40")).toBeTruthy();
    expect(screen.getByText("20 %")).toBeTruthy(); // 10 canceladas de 50
    expect(screen.getByText("8 %")).toBeTruthy(); // 3 no vinieron de 40
    expect(screen.getByText("56 %")).toBeTruthy(); // 28 de 50 conversaciones
    expect(screen.getByText("1 h 15 min")).toBeTruthy();
    const sources = screen.getByRole("heading", { name: "Por origen" }).closest("section")!;
    expect(within(sources).getByText("Chat web")).toBeTruthy();
    expect(within(sources).getByText("28")).toBeTruthy();
    expect(screen.getByText("Corte de mujer")).toBeTruthy();
    expect(screen.getByText("30 % · 90 de 300 h")).toBeTruthy();
    expect(screen.getByText("Sin horario en el período")).toBeTruthy();
  });

  it("cambiar el período pide otro rango", async () => {
    api();
    renderAt("/metricas");
    const period = await screen.findByRole("radiogroup", { name: "Período" });
    fireEvent.click(within(period).getByRole("radio", { name: "Últimos 7 días" }));
    const today = todayIn(TZ);
    await waitFor(() => expect(asked().some((u) => u.includes(`from=${addDays(today, -6)}&to=${today}`))).toBe(true));
    expect(calls.length).toBeGreaterThan(0);
  });

  it("cálculos", () => {
    expect(periodRange(7, "2026-10-19")).toEqual({ from: "2026-10-13", to: "2026-10-19" });
    expect(percent(1, 3)).toBe("33 %");
    expect(percent(0, 0)).toBe("—");
  });
});
