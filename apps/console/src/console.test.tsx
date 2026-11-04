// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { safeRedirect } from "./routes/Login.js";
import { json, ME_ADMIN, ME_STAFF, mockApi, renderAt, sent, setupBrowser, type Handler } from "./test-api.js";

// API simulada y usuarios de ejemplo: test-api.tsx
const ORG = {
  id: "org1",
  name: "Salón Aurora",
  members: [
    { id: "m1", userId: "u-valeria", role: "owner", user: { name: "Valeria Ríos", email: "valeria@salon-aurora.test" } },
    { id: "m2", userId: "u-camila", role: "member", user: { name: "Camila", email: "camila@salon-aurora.test" } },
  ],
  invitations: [{ id: "inv1", email: "diego@salon-aurora.test", role: "member", status: "pending", expiresAt: "2026-10-20T12:00:00Z" }],
};
const NOT_READY = {
  ready: false,
  checks: [
    { key: "services", ok: false, required: true },
    { key: "hours", ok: true, required: true },
    { key: "web_chat_slug", ok: true, required: true },
    { key: "agent_knowledge", ok: false, required: false },
  ],
};

const posted = (path: string) => sent("POST", path);

beforeEach(setupBrowser);

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// ---------- tests ----------

describe("acceso", () => {
  it("sin sesión, la consola lleva a ingresar", async () => {
    mockApi({ "GET /api/me": () => json({ error: "unauthorized" }, 401) });
    renderAt("/usuarios");
    expect(await screen.findByRole("heading", { name: "Ingresa a tu negocio" })).toBeTruthy();
  });

  it("valida el formulario, avisa si la contraseña es incorrecta y al ingresar muestra el inicio", async () => {
    let loggedIn = false;
    mockApi({
      "GET /api/me": () => (loggedIn ? ME_ADMIN : json({ error: "unauthorized" }, 401)),
      "POST /api/auth/sign-in/email": (b) => {
        if (b.password !== "aurora-dev-2026") return json({ code: "INVALID_EMAIL_OR_PASSWORD", message: "x" }, 401);
        loggedIn = true;
        return { redirect: false, token: "t", user: {} };
      },
      "GET /api/merchant/readiness": () => NOT_READY,
    });
    renderAt("/ingresar");
    await screen.findByRole("heading", { name: "Ingresa a tu negocio" });

    fireEvent.click(screen.getByRole("button", { name: "Ingresar" }));
    expect(await screen.findByText("Escribe un correo válido.")).toBeTruthy();
    expect(screen.getByText("Escribe tu contraseña.")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Correo"), { target: { value: "valeria@salon-aurora.test" } });
    fireEvent.change(screen.getByLabelText("Contraseña"), { target: { value: "otra" } });
    fireEvent.click(screen.getByRole("button", { name: "Ingresar" }));
    expect(await screen.findByText("Correo o contraseña incorrectos.")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Contraseña"), { target: { value: "aurora-dev-2026" } });
    fireEvent.click(screen.getByRole("button", { name: "Ingresar" }));
    expect(await screen.findByRole("heading", { name: "Hola, Valeria" })).toBeTruthy();
    expect(posted("/api/auth/sign-in/email").at(-1)?.body).toEqual({ email: "valeria@salon-aurora.test", password: "aurora-dev-2026" });
  });

  it("solo redirige dentro de la consola", () => {
    expect(safeRedirect("/usuarios")).toBe("/usuarios");
    expect(safeRedirect("https://malicioso.example")).toBe("/");
    expect(safeRedirect("//malicioso.example")).toBe("/");
    expect(safeRedirect(undefined)).toBe("/");
  });

  it("elegir contraseña: valida y confirma", async () => {
    mockApi({ "POST /api/auth/reset-password": () => ({ status: true }) });
    renderAt("/restablecer?token=abc");
    await screen.findByRole("heading", { name: "Elige tu contraseña" });
    fireEvent.change(screen.getByLabelText("Contraseña nueva"), { target: { value: "clave-nueva-123" } });
    fireEvent.change(screen.getByLabelText("Repite la contraseña"), { target: { value: "otra-cosa-123" } });
    fireEvent.click(screen.getByRole("button", { name: "Guardar contraseña" }));
    expect(await screen.findByText("Las contraseñas no coinciden.")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Repite la contraseña"), { target: { value: "clave-nueva-123" } });
    fireEvent.click(screen.getByRole("button", { name: "Guardar contraseña" }));
    expect(await screen.findByText("Listo. Ya puedes ingresar con tu contraseña.")).toBeTruthy();
    expect(posted("/api/auth/reset-password")[0].body).toEqual({ newPassword: "clave-nueva-123", token: "abc" });
  });

  it("un enlace de contraseña sin token o vencido lo dice", async () => {
    mockApi({});
    renderAt("/restablecer?error=INVALID_TOKEN");
    expect(await screen.findByText("El enlace venció o ya se usó. Pide uno nuevo.")).toBeTruthy();
  });
});

describe("invitaciones", () => {
  it("muestra el negocio y el rol; crea la cuenta y acepta", async () => {
    mockApi({
      "GET /api/me": () => json({ error: "unauthorized" }, 401),
      "GET /api/invitations/inv1": () => ({ organization: "Salón Aurora", email: "diego@salon-aurora.test", role: "merchant_staff", status: "pending" }),
      "POST /api/auth/sign-up/email": () => ({ token: "t", user: { id: "u-diego" } }),
      "POST /api/auth/organization/accept-invitation": () => ({ invitation: {}, member: { organizationId: "org1" } }),
      "POST /api/auth/organization/set-active": () => ({ id: "org1" }),
    });
    renderAt("/invitacion/inv1");
    expect(await screen.findByRole("heading", { name: "Te invitaron a Salón Aurora" })).toBeTruthy();
    expect(screen.getByText("Vas a entrar como staff.")).toBeTruthy();
    expect((screen.getByLabelText("Correo") as HTMLInputElement).value).toBe("diego@salon-aurora.test");

    fireEvent.change(screen.getByLabelText("Tu nombre"), { target: { value: "Diego" } });
    fireEvent.change(screen.getByLabelText("Contraseña nueva"), { target: { value: "clave-de-diego" } });
    fireEvent.click(screen.getByRole("button", { name: "Aceptar invitación" }));
    await waitFor(() => expect(posted("/api/auth/organization/set-active")).toHaveLength(1));
    expect(posted("/api/auth/sign-up/email")[0].body).toEqual({
      email: "diego@salon-aurora.test",
      password: "clave-de-diego",
      name: "Diego",
      locale: "es",
    });
    expect(posted("/api/auth/organization/accept-invitation")[0].body).toEqual({ invitationId: "inv1" });
  });

  it("una invitación vencida lo dice", async () => {
    mockApi({
      "GET /api/me": () => json({ error: "unauthorized" }, 401),
      "GET /api/invitations/viejo": () => ({ organization: "Salón Aurora", email: "x@y.test", role: "merchant_staff", status: "expired" }),
    });
    renderAt("/invitacion/viejo");
    expect(await screen.findByText("Esta invitación venció. Pide al negocio que te invite de nuevo.")).toBeTruthy();
  });
});

describe("inicio", () => {
  it("el administrador ve lo que falta con enlaces para configurarlo", async () => {
    mockApi({ "GET /api/me": () => ME_ADMIN, "GET /api/merchant/readiness": () => NOT_READY });
    renderAt("/");
    expect(await screen.findByRole("heading", { name: "Falta configurar tu negocio" })).toBeTruthy();
    const services = screen.getByText("Al menos un servicio activo con un profesional").closest("li")!;
    expect(within(services).getByText("Pendiente")).toBeTruthy();
    expect(within(services).getByRole("link", { name: "Configurar" }).getAttribute("href")).toBe("/servicios");
    const hours = screen.getByText("El horario del local").closest("li")!;
    expect(within(hours).getByText("Listo")).toBeTruthy();
    expect(screen.getByText("Recomendado")).toBeTruthy();
  });

  it("el staff ve el estado sin enlaces para configurar", async () => {
    mockApi({ "GET /api/me": () => ME_STAFF, "GET /api/merchant/readiness": () => NOT_READY });
    renderAt("/");
    await screen.findByRole("heading", { name: "Falta configurar tu negocio" });
    expect(screen.queryByRole("link", { name: "Configurar" })).toBeNull();
  });

  it("la consola sale en el idioma guardado en la cuenta", async () => {
    mockApi({
      "GET /api/me": () => ({ ...ME_ADMIN, user: { ...ME_ADMIN.user, locale: "en" } }),
      "GET /api/merchant/readiness": () => ({ ...NOT_READY, ready: true, checks: NOT_READY.checks.map((c) => ({ ...c, ok: true })) }),
    });
    renderAt("/");
    expect(await screen.findByRole("heading", { name: "Your chat is ready to take bookings" })).toBeTruthy();
    expect(screen.getAllByRole("link", { name: "Users" }).length).toBeGreaterThan(0);
  });
});

describe("usuarios", () => {
  const orgRoutes = (extra: Record<string, Handler> = {}) => ({
    "GET /api/merchant/readiness": () => NOT_READY,
    "GET /api/auth/organization/get-full-organization": () => ORG,
    "GET /api/auth/organization/list": () => [ORG],
    ...extra,
  });

  it("el administrador ve miembros con su rol e invita", async () => {
    mockApi({
      "GET /api/me": () => ME_ADMIN,
      ...orgRoutes({ "POST /api/auth/organization/invite-member": (b) => ({ id: "inv2", ...b, status: "pending" }) }),
    });
    renderAt("/usuarios");
    await screen.findByRole("heading", { name: "Usuarios" });
    // el nombre también está en el menú del usuario: el de la lista de miembros
    const valeria = (await screen.findAllByText("Valeria Ríos")).map((e) => e.closest("li")).find(Boolean)!;
    expect(within(valeria).getByText("Dueño")).toBeTruthy();
    expect(within(valeria).getByText("Tú")).toBeTruthy();
    expect(within(valeria).queryByRole("button", { name: "Quitar acceso" })).toBeNull(); // nadie quita a la dueña
    const camila = screen.getByText("Camila").closest("li")!;
    expect((within(camila).getByRole("combobox") as HTMLSelectElement).value).toBe("member");
    expect(screen.getByText("diego@salon-aurora.test")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Correo"), { target: { value: "lucia@salon-aurora.test" } });
    fireEvent.change(screen.getByLabelText("Rol"), { target: { value: "admin" } });
    fireEvent.click(screen.getByRole("button", { name: "Enviar invitación" }));
    expect(await screen.findByText("Invitación enviada a lucia@salon-aurora.test.")).toBeTruthy();
    expect(posted("/api/auth/organization/invite-member")[0].body).toEqual({
      email: "lucia@salon-aurora.test",
      role: "admin",
      organizationId: "org1",
    });
  });

  it("los errores de Better Auth se explican en el idioma de la consola", async () => {
    mockApi({
      "GET /api/me": () => ME_ADMIN,
      ...orgRoutes({
        "POST /api/auth/organization/invite-member": () =>
          json({ code: "USER_IS_ALREADY_INVITED_TO_THIS_ORGANIZATION", message: "User is already invited" }, 400),
      }),
    });
    renderAt("/usuarios");
    fireEvent.change(await screen.findByLabelText("Correo"), { target: { value: "diego@salon-aurora.test" } });
    fireEvent.click(screen.getByRole("button", { name: "Enviar invitación" }));
    expect(await screen.findByText("Esa persona ya tiene una invitación pendiente. Usa Reenviar.")).toBeTruthy();
  });

  it("el staff ve el equipo pero no puede invitar ni cambiar roles", async () => {
    mockApi({ "GET /api/me": () => ME_STAFF, ...orgRoutes() });
    renderAt("/usuarios");
    expect(await screen.findByText("Solo los administradores pueden invitar, cambiar roles o quitar accesos.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Enviar invitación" })).toBeNull();
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByRole("button", { name: "Reenviar" })).toBeNull();
  });
});
