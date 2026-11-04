import { expect, test } from "@playwright/test";
import { CHAT, CONSOLE, nextWednesday, signIn, USERS } from "./support.js";

// Recorridos completos con datos de prueba y el LLM simulado (solo en local y CI).

test("el equipo crea una reserva desde la agenda y queda en su columna", async ({ page }) => {
  await signIn(page, USERS.valeria);
  const date = nextWednesday();
  await page.goto(`${CONSOLE}/agenda?date=${date}`);
  await page.getByRole("button", { name: "Nueva reserva" }).click();
  const panel = page.getByRole("dialog");
  await panel.getByLabel("Profesional").selectOption({ label: "Valeria" });
  await panel.getByRole("button", { name: "10:00", exact: true }).click();
  await panel.getByRole("button", { name: "Cliente nuevo" }).click();
  await panel.getByLabel("Nombre").fill("Lucía Prueba");
  await panel.getByLabel("Teléfono").fill("9 5555 0199");
  await panel.getByRole("button", { name: "Guardar reserva" }).click();
  await expect(page.getByText("Reserva creada.")).toBeVisible();
  await expect(page.getByRole("button", { name: /Lucía Prueba/ })).toBeVisible();
});

test("el cliente pide una persona, el equipo responde desde la consola y el cliente lo ve en su chat", async ({ browser }) => {
  const customer = await browser.newPage();
  await customer.goto(`${CHAT}/salon-aurora`);
  await expect(customer.getByRole("heading", { name: "Salón Aurora" })).toBeVisible();
  await customer.getByRole("textbox").fill("Quiero hablar con una persona");
  await customer.getByRole("button", { name: /enviar/i }).click();
  await expect(customer.getByText("Te comunico con una persona del equipo.")).toBeVisible();
  await expect(customer.getByText(/Una persona del equipo seguirá esta conversación/)).toBeVisible();

  const team = await browser.newPage();
  await signIn(team, USERS.camila);
  await team.getByRole("link", { name: /Conversaciones/ }).click();
  await team.getByRole("tab", { name: /Esperan al equipo/ }).click();
  await team.getByRole("link", { name: /Te comunico con una persona del equipo/ }).first().click();
  await team.getByLabel("Tu respuesta").fill("Hola, soy Camila del Salón Aurora.");
  await team.getByRole("button", { name: "Enviar" }).click();
  await expect(team.getByText("Respuesta enviada.")).toBeVisible();

  // el chat consulta cada 5 s mientras el equipo atiende
  await expect(customer.getByText("Hola, soy Camila del Salón Aurora.")).toBeVisible({ timeout: 15_000 });
});
