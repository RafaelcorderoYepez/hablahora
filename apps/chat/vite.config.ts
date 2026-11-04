import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defaultClientConditions, defineConfig } from "vite";

// Chat público. En desarrollo, /api va a la API en el puerto 3000: mismo origen, sin CORS.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // los paquetes del monorepo se usan desde su código fuente
  resolve: { conditions: ["@hablahora/source", ...defaultClientConditions] },
  server: {
    port: 5173,
    strictPort: true,
    proxy: { "/api": { target: "http://localhost:3000" } },
  },
  build: { outDir: "dist", sourcemap: true },
});
