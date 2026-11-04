import type { Locale } from "./i18n.js";

// Lo que el navegador recuerda por negocio: la sesión abierta y el idioma elegido.
// localStorage puede no estar disponible (modo privado, bloqueado): nada se rompe.

const key = (slug: string) => `hablahora-chat:${slug}`;

interface Stored {
  sessionId?: string;
  locale?: Locale;
}

function read(slug: string): Stored {
  try {
    return JSON.parse(localStorage.getItem(key(slug)) ?? "{}") as Stored;
  } catch {
    return {};
  }
}

function write(slug: string, value: Stored) {
  try {
    localStorage.setItem(key(slug), JSON.stringify(value));
  } catch {
    /* sin almacenamiento: la conversación dura lo que dure la pestaña */
  }
}

export const storage = {
  get: read,
  setSession(slug: string, sessionId: string | undefined) {
    write(slug, { ...read(slug), sessionId });
  },
  setLocale(slug: string, locale: Locale) {
    write(slug, { ...read(slug), locale });
  },
};
