// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { json, ME_ADMIN, mockApi, renderAt, sent, setupBrowser, type Handler } from "./test-api.js";

/** H7, parte 1: logo del negocio en su chat y aviso de privacidad de la plataforma. */

const BUSINESS = {
  name: "Salón Aurora",
  locationName: "Brickell",
  address: null,
  timezone: "America/New_York",
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

let logoUrl: string | null = null;

function merchant(extra: Record<string, Handler> = {}) {
  mockApi({
    "GET /api/me": () => ME_ADMIN,
    "GET /api/merchant/readiness": () => ({ ready: true, checks: [] }),
    "GET /api/merchant/handoff/count": () => ({ count: 0 }),
    "GET /api/merchant/business": () => BUSINESS,
    "GET /api/merchant/web-chat": () => ({
      slug: "salon-aurora",
      enabled: true,
      publicUrl: "https://chat.hablahora.test/salon-aurora",
      embedScriptUrl: "https://chat.hablahora.test/embed.js",
      logoUrl,
    }),
    "GET /api/auth/organization/list": () => [],
    ...extra,
  });
}

beforeEach(() => {
  setupBrowser();
  logoUrl = null;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const png = (bytes = 1024) => new File([new Uint8Array(bytes)], "logo.png", { type: "image/png" });

describe("logo del chat", () => {
  it("sube el logo: lo manda tal cual con su tipo y muestra el nuevo", async () => {
    merchant({
      "PUT /api/merchant/web-chat/logo": () => {
        logoUrl = "/api/chat/salon-aurora/logo?v=2";
        return { logoUrl };
      },
    });
    renderAt("/chat-web");
    const card = (await screen.findByRole("heading", { name: "Logo" })).closest("section")!;
    expect(within(card).queryByRole("img")).toBeNull();
    const file = png();
    fireEvent.change(within(card).getByLabelText("Subir logo"), { target: { files: [file] } });
    expect(await screen.findByText("Logo guardado.")).toBeTruthy();
    expect(sent("PUT", "/api/merchant/web-chat/logo")[0].body).toBe(file);
    expect((await within(card).findByRole("img", { name: "Logo del negocio" })).getAttribute("src")).toBe("/api/chat/salon-aurora/logo?v=2");
    expect(within(card).getByLabelText("Cambiar logo")).toBeTruthy();
  });

  it("revisa tipo y tamaño antes de subir; un rechazo de la API se explica", async () => {
    merchant({ "PUT /api/merchant/web-chat/logo": () => json({ error: "unprocessable", reason: "logo_invalid", message: "x" }, 422) });
    renderAt("/chat-web");
    const card = (await screen.findByRole("heading", { name: "Logo" })).closest("section")!;
    const input = within(card).getByLabelText("Subir logo");
    fireEvent.change(input, { target: { files: [new File(["<svg/>"], "logo.svg", { type: "image/svg+xml" })] } });
    expect(await screen.findByText("El logo debe ser PNG, JPEG o WebP.")).toBeTruthy();
    fireEvent.change(input, { target: { files: [png(300 * 1024)] } });
    expect(await screen.findByText("El logo puede pesar hasta 256 KB. Prueba con una imagen más chica.")).toBeTruthy();
    expect(sent("PUT", "/api/merchant/web-chat/logo")).toHaveLength(0);

    fireEvent.change(input, { target: { files: [png()] } });
    await waitFor(() => expect(sent("PUT", "/api/merchant/web-chat/logo")).toHaveLength(1));
    expect((await screen.findAllByText("El logo debe ser PNG, JPEG o WebP.")).length).toBeGreaterThan(0);
  });

  it("quitar el logo", async () => {
    logoUrl = "/api/chat/salon-aurora/logo?v=1";
    merchant({
      "DELETE /api/merchant/web-chat/logo": () => {
        logoUrl = null;
        return new Response(null, { status: 204 });
      },
    });
    renderAt("/chat-web");
    const card = (await screen.findByRole("heading", { name: "Logo" })).closest("section")!;
    fireEvent.click(await within(card).findByRole("button", { name: "Quitar logo" }));
    expect(await screen.findByText("Logo quitado.")).toBeTruthy();
    await waitFor(() => expect(within(card).queryByRole("img")).toBeNull());
  });
});

describe("aviso de privacidad", () => {
  it("la plataforma escribe el texto en los dos idiomas y lo guarda sin cambiar el modelo", async () => {
    mockApi({
      "GET /api/me": () => ({ ...ME_ADMIN, platformAdmin: true, business: null }),
      "GET /api/platform/settings": () => ({
        defaultModel: "claude-opus-5-5",
        serverModel: "claude-sonnet-5-5",
        models: ["claude-sonnet-5-5", "claude-opus-5-5"],
        privacyEs: null,
        privacyEn: null,
      }),
      "PUT /api/platform/settings": (body) => ({
        defaultModel: body.defaultModel,
        serverModel: "claude-sonnet-5-5",
        models: [],
        privacyEs: body.privacyEs,
        privacyEn: body.privacyEn,
      }),
      "GET /api/auth/organization/list": () => [],
    });
    renderAt("/plataforma/configuracion");
    fireEvent.change(await screen.findByLabelText("En español"), { target: { value: "Usamos tus datos solo para tu reserva." } });
    fireEvent.change(screen.getByLabelText("En inglés"), { target: { value: "We only use your data for your booking." } });
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
    expect(await screen.findByText("Aviso de privacidad guardado.")).toBeTruthy();
    expect(sent("PUT", "/api/platform/settings")[0].body).toEqual({
      defaultModel: "claude-opus-5-5",
      privacyEs: "Usamos tus datos solo para tu reserva.",
      privacyEn: "We only use your data for your booking.",
    });
  });
});
