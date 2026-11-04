import { expect, test } from "@playwright/test";
import { CHAT, CONSOLE, signIn, USERS } from "./support.js";

// De humo: también corren contra staging (no gastan en el modelo ni cambian datos).

test("la consola abre, se ingresa y la agenda carga @smoke", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await signIn(page, USERS.valeria);
  await page.getByRole("link", { name: "Agenda" }).click();
  await expect(page.getByRole("heading", { name: "Agenda" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Nueva reserva" })).toBeVisible();
  expect(errors).toEqual([]);
});

// con el navegador (no con el cliente HTTP de Node): resuelve app.localhost y chat.localhost
test("la consola no se puede incrustar en otro sitio; el chat sí @smoke", async ({ page }) => {
  const consolePage = await page.goto(`${CONSOLE}/ingresar`);
  expect(consolePage?.headers()["content-security-policy"]).toContain("frame-ancestors 'none'");
  const chatPage = await page.goto(`${CHAT}/salon-aurora`);
  expect(chatPage?.headers()["content-security-policy"]).toContain("frame-ancestors *");
  expect((await page.goto(`${CHAT}/embed.js`))?.ok()).toBe(true);
});
