import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defaultClientConditions, defineConfig } from "vite";

// Consola del negocio. En desarrollo, /api va a la API: mismo origen, la cookie de sesión funciona sin CORS.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { conditions: ["@hablahora/source", ...defaultClientConditions] },
  server: {
    port: 5174,
    strictPort: true,
    proxy: { "/api": { target: "http://localhost:3000", changeOrigin: false } },
  },
  build: { outDir: "dist", sourcemap: true },
});
