// Desarrollo: compila la API en modo watch y la reinicia cuando cambia dist/, y levanta
// el chat público (http://localhost:5173/salon-aurora) y la consola (http://localhost:5174) con Vite.
// Uso: npm run dev (requiere .env en la raíz; copiar de .env.example).
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

if (!existsSync(".env")) {
  console.error("Falta .env en la raíz del repo: cp .env.example .env");
  process.exit(1);
}

const tsc = "node_modules/.bin/tsc";
const build = spawn(tsc, ["-b", "tsconfig.build.json"], { stdio: "inherit" });
build.on("exit", (code) => {
  if (code !== 0) process.exit(code ?? 1);

  const children = [
    spawn(tsc, ["-b", "tsconfig.build.json", "--watch", "--preserveWatchOutput"], { stdio: "inherit" }),
    spawn(process.execPath, ["--watch", "--env-file=.env", "apps/api/dist/main.js"], { stdio: "inherit" }),
    spawn("../../node_modules/.bin/vite", [], { cwd: "apps/chat", stdio: "inherit" }),
    spawn("../../node_modules/.bin/vite", [], { cwd: "apps/console", stdio: "inherit" }),
  ];
  let stopping = false;
  const stop = () => {
    stopping = true;
    children.forEach((c) => c.kill("SIGTERM"));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  // si uno de los dos termina solo, se cierra el otro y se sale con error
  children.forEach((c) =>
    c.on("exit", () => {
      if (!stopping) process.exitCode = 1;
      stop();
    }),
  );
});
