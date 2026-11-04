import { defaultServerConditions } from "vite";
import { defineConfig } from "vitest/config";

// Los paquetes del monorepo se importan desde su código fuente (condición
// "@hablahora/source"), así los tests no dependen de compilar antes.
// `ssr` corre los tests y `__vitest__` el globalSetup. Sin "module" (como hace
// Vitest por defecto): Node también recibe estas condiciones y con "module"
// carga builds ESM que no funcionan en Node (p. ej. @opentelemetry).
const resolve = {
  conditions: ["@hablahora/source", ...defaultServerConditions.filter((c) => c !== "module")],
};

export default defineConfig({
  environments: { ssr: { resolve }, __vitest__: { resolve } },
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts", "apps/*/src/**/*.test.{ts,tsx}"],
    globalSetup: ["./test/support/global-setup.ts"],
    testTimeout: 20_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
