import { MemoryEmailSender } from "@hablahora/core";
import { AURORA, seedSalonAurora } from "@hablahora/db";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAuth } from "../../src/auth.js";
import { AURORA_USERS, DEV_PASSWORD, seedAuroraUsers } from "../../src/seed-users.js";
import { buildServer } from "../../src/server.js";
import { browser, ORIGIN } from "../../../../test/support/auth.js";
import { ADMIN_URL, APP_URL, AUTH_URL } from "../../../../test/support/global-setup.js";

let admin: pg.Pool;
let app: pg.Pool;
let emails: MemoryEmailSender;
let authDb: pg.Pool;
let auth: ReturnType<typeof createAuth>["auth"];
let server: ReturnType<typeof buildServer>;

beforeAll(async () => {
  admin = new pg.Pool({ connectionString: ADMIN_URL });
  app = new pg.Pool({ connectionString: APP_URL, max: 5 });
  emails = new MemoryEmailSender();
  const created = createAuth({
    databaseUrl: AUTH_URL,
    baseURL: ORIGIN,
    secret: "secreto-de-tests-0123456789-0123456789",
    trustedOrigins: [ORIGIN],
    consoleURL: "http://consola.test",
    email: emails,
  });
  authDb = created.pool;
  auth = created.auth;
  server = buildServer({ auth: { auth, authDb, db: app, trustedOrigins: [ORIGIN] } });
});

afterAll(async () => {
  await server.app.close();
  await authDb.end();
  await app.end();
  await admin.end();
});

beforeEach(async () => {
  await seedSalonAurora(admin);
  await authDb.query(`DELETE FROM "user" WHERE email LIKE '%@nuevo.test'`);
  await seedAuroraUsers({ auth, authDb, adminDb: admin, tenantId: AURORA.tenant, slug: AURORA.slug });
  emails.sent = [];
});

const login = async (email: string, password = DEV_PASSWORD) => {
  const b = browser(server.app);
  const res = await b.signIn(email, password);
  return { b, res };
};

describe("ingreso a las consolas", () => {
  it("cada usuario ve su rol: dueña, staff y administrador de plataforma", async () => {
    const valeria = await login(AURORA_USERS.valeria.email);
    expect(valeria.res.statusCode).toBe(200);
    expect((await valeria.b.get("/api/me")).json()).toMatchObject({
      user: { email: AURORA_USERS.valeria.email },
      platformAdmin: false,
      business: { tenantId: AURORA.tenant, name: "Salón Aurora", role: "merchant_admin" },
    });

    const camila = await login(AURORA_USERS.camila.email);
    expect((await camila.b.get("/api/me")).json().business).toMatchObject({ role: "merchant_staff" });

    const platform = await login(AURORA_USERS.platformAdmin.email);
    expect((await platform.b.get("/api/me")).json()).toMatchObject({ platformAdmin: true, business: null });
  });

  it("contraseña incorrecta o sin sesión: no entra", async () => {
    const { b, res } = await login(AURORA_USERS.valeria.email, "no-es-esta-clave");
    expect(res.statusCode).toBe(401);
    expect((await b.get("/api/me")).statusCode).toBe(401);
  });

  it("rechaza peticiones desde un origen que no es de confianza", async () => {
    const res = await browser(server.app, "https://malicioso.example").signIn(AURORA_USERS.valeria.email, DEV_PASSWORD);
    expect(res.statusCode).toBe(403);
  });

  it("al salir del negocio pierde el acceso de inmediato", async () => {
    const { b } = await login(AURORA_USERS.camila.email);
    expect((await b.get("/api/me")).json().business).not.toBeNull();
    await authDb.query(`DELETE FROM member WHERE "userId" = (SELECT id FROM "user" WHERE email = $1)`, [
      AURORA_USERS.camila.email,
    ]);
    expect((await b.get("/api/me")).json().business).toBeNull();
  });
});

describe("cuentas nuevas solo por invitación", () => {
  it("sin invitación no se puede crear una cuenta", async () => {
    const res = await browser(server.app).post("/api/auth/sign-up/email", {
      email: "intruso@nuevo.test",
      password: "una-clave-larga-123",
      name: "Intruso",
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    const { rowCount } = await authDb.query(`SELECT 1 FROM "user" WHERE email = 'intruso@nuevo.test'`);
    expect(rowCount).toBe(0);
  });

  it("la dueña invita, la persona crea su cuenta, acepta y queda como staff", async () => {
    const valeria = await login(AURORA_USERS.valeria.email);
    const orgId = (await authDb.query(`SELECT id FROM organization WHERE slug = $1`, [AURORA.slug])).rows[0].id;
    const invite = await valeria.b.post("/api/auth/organization/invite-member", {
      email: "diego@nuevo.test",
      role: "member",
      organizationId: orgId,
    });
    expect(invite.statusCode).toBe(200);

    const mail = emails.lastTo("diego@nuevo.test");
    expect(mail?.subject).toContain("Salón Aurora");
    const invitationId = /invitacion\/(\S+)/.exec(mail!.text)![1];
    expect(mail!.text).toContain("http://consola.test/invitacion/");

    const diego = browser(server.app);
    const signUp = await diego.post("/api/auth/sign-up/email", {
      email: "diego@nuevo.test",
      password: "una-clave-larga-123",
      name: "Diego",
    });
    expect(signUp.statusCode).toBe(200);
    const accept = await diego.post("/api/auth/organization/accept-invitation", { invitationId });
    expect(accept.statusCode).toBe(200);
    expect((await diego.get("/api/me")).json().business).toMatchObject({
      tenantId: AURORA.tenant,
      role: "merchant_staff",
    });
  });

  it("el staff no puede invitar ni nadie puede crear negocios desde la consola", async () => {
    const camila = await login(AURORA_USERS.camila.email);
    const orgId = (await authDb.query(`SELECT id FROM organization WHERE slug = $1`, [AURORA.slug])).rows[0].id;
    const invite = await camila.b.post("/api/auth/organization/invite-member", {
      email: "otro@nuevo.test",
      role: "member",
      organizationId: orgId,
    });
    expect(invite.statusCode).toBe(403);
    expect(emails.sent).toEqual([]);

    const valeria = await login(AURORA_USERS.valeria.email);
    const create = await valeria.b.post("/api/auth/organization/create", { name: "Otro", slug: "otro" });
    expect(create.statusCode).toBe(403);
  });
});

describe("recuperar contraseña", () => {
  it("manda un enlace por correo y con él se cambia la contraseña", async () => {
    const res = await browser(server.app).post("/api/auth/request-password-reset", {
      email: AURORA_USERS.camila.email,
      redirectTo: "http://consola.test/nueva-clave",
    });
    expect(res.statusCode).toBe(200);
    const mail = emails.lastTo(AURORA_USERS.camila.email);
    expect(mail?.subject).toContain("contraseña");
    const token = /reset-password\/([^?\s]+)/.exec(mail!.text)![1];

    const reset = await browser(server.app).post("/api/auth/reset-password", {
      token,
      newPassword: "clave-nueva-de-camila",
    });
    expect(reset.statusCode).toBe(200);
    expect((await login(AURORA_USERS.camila.email, "clave-nueva-de-camila")).res.statusCode).toBe(200);
    expect((await login(AURORA_USERS.camila.email)).res.statusCode).toBe(401);
  });
});
