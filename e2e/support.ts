import { expect, type Page } from "@playwright/test";

const port = Number(process.env.E2E_PORT ?? 4319);
export const CONSOLE = process.env.E2E_CONSOLE_URL ?? `http://app.localhost:${port}`;
export const CHAT = process.env.E2E_CHAT_URL ?? `http://chat.localhost:${port}`;

export const USERS = {
  valeria: { email: process.env.E2E_EMAIL ?? "valeria@salon-aurora.test", password: process.env.E2E_PASSWORD ?? "aurora-dev-2026" },
  camila: { email: "camila@salon-aurora.test", password: "aurora-dev-2026" },
};

/** Ingresa a la consola y espera el inicio. */
export async function signIn(page: Page, who: { email: string; password: string }) {
  await page.goto(`${CONSOLE}/ingresar`);
  await page.getByLabel("Correo").fill(who.email);
  await page.getByLabel("Contraseña").fill(who.password);
  await page.getByRole("button", { name: "Ingresar" }).click();
  await expect(page.getByRole("heading", { name: /^Hola,/ })).toBeVisible();
}

/** El próximo miércoles (YYYY-MM-DD): Valeria atiende de 9 a 19. */
export function nextWednesday(from = new Date()): string {
  const d = new Date(Date.UTC(from.getFullYear(), from.getMonth(), from.getDate()));
  do d.setUTCDate(d.getUTCDate() + 1);
  while (d.getUTCDay() !== 3);
  return d.toISOString().slice(0, 10);
}
