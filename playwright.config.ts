import { defineConfig } from "@playwright/test";

// Pruebas de punta a punta. En local (y en CI) levantan su propio servidor (e2e/server.mjs)
// con datos conocidos y un LLM simulado. Contra staging (E2E_CONSOLE_URL y E2E_CHAT_URL)
// solo corren las de humo (@smoke): no gastan en el modelo ni cambian datos.
const staging = !!process.env.E2E_CONSOLE_URL;
const port = Number(process.env.E2E_PORT ?? 4319);

export default defineConfig({
  testDir: "e2e",
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  grep: staging ? /@smoke/ : undefined,
  use: {
    // en local se puede usar el Chrome instalado: PW_CHANNEL=chrome
    channel: process.env.PW_CHANNEL,
    locale: "es-MX",
    trace: "retain-on-failure",
  },
  webServer: staging
    ? undefined
    : {
        command: "node e2e/server.mjs",
        url: `http://127.0.0.1:${port}/health`,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      },
});
