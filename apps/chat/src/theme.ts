import { accentForDark, BRAND } from "@hablahora/contracts/browser";
import type { PublicChatInfo } from "@hablahora/contracts";

/**
 * Pinta el chat con el color del negocio y su apariencia (claro, oscuro o la
 * del dispositivo). Devuelve una función para dejar de seguir al dispositivo.
 */
export function applyTheme(info: Pick<PublicChatInfo, "accent" | "appearance">, root = document.documentElement) {
  root.style.setProperty("--ui-accent-light", info.accent);
  root.style.setProperty("--ui-accent-dark", accentForDark(info.accent));

  const media = window.matchMedia?.("(prefers-color-scheme: dark)");
  const update = () => {
    const dark = info.appearance === "dark" || (info.appearance === "auto" && !!media?.matches);
    root.classList.toggle("dark", dark);
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", dark ? BRAND.background.dark : BRAND.background.light);
  };
  update();
  if (info.appearance !== "auto" || !media) return () => {};
  media.addEventListener("change", update);
  return () => media.removeEventListener("change", update);
}
