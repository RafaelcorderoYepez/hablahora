/**
 * Lo que el navegador necesita de los contratos, sin Zod: contraste, paletas
 * del chat y límites. Así el chat público no carga los esquemas de validación.
 */

export function relativeLuminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [n >> 16, (n >> 8) & 255, n & 255].map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Contraste WCAG 2 entre dos colores #RRGGBB (de 1 a 21). */
export function contrastRatio(a: string, b: string): number {
  const [x, y] = [relativeLuminance(a), relativeLuminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

/**
 * La marca del producto en textos y correos. Los colores y las fuentes están en
 * `packages/ui/src/styles.css` y el logo en `packages/ui/src/logo.tsx`.
 */
export const BRAND = {
  name: "HablaHora",
  /** fondos de la página (meta theme-color y validación de contraste en modo oscuro) */
  background: { light: "#F3F6F5", dark: "#0E1B1D" },
} as const;

/**
 * Países donde opera la plataforma. El país del negocio decide su moneda, cómo se completan
 * los teléfonos sin prefijo y los valores por defecto del alta. Se fija al crear el negocio.
 */
export const COUNTRIES = {
  CL: { currency: "CLP", timezone: "America/Santiago", locale: "es", phonePrefix: "56", es: "Chile", en: "Chile" },
  US: { currency: "USD", timezone: "America/New_York", locale: "en", phonePrefix: "1", es: "Estados Unidos", en: "United States" },
} as const;
export type CountryCode = keyof typeof COUNTRIES;
export const COUNTRY_CODES = Object.keys(COUNTRIES) as CountryCode[];

/** Monedas: los montos se guardan enteros en la unidad mínima (pesos, centavos). */
export const CURRENCIES = {
  CLP: { decimals: 0, format: "es-CL" },
  USD: { decimals: 2, format: "en-US" },
} as const;
export type CurrencyCode = keyof typeof CURRENCIES;

/**
 * Monto en la unidad mínima → texto como se escribe en el país de la moneda
 * (sigue a la moneda, no al idioma de la pantalla): 18000 CLP → "$18.000"; 1850 USD → "$18.50".
 */
export function formatMoney(amount: number, currency: CurrencyCode): string {
  const c = CURRENCIES[currency];
  return new Intl.NumberFormat(c.format, {
    style: "currency",
    currency,
    minimumFractionDigits: c.decimals,
    maximumFractionDigits: c.decimals,
  }).format(amount / 10 ** c.decimals);
}

/** Monto para un campo editable, sin símbolo: 18000 CLP → "18.000"; 1850 USD → "18.50". */
export function formatMoneyInput(amount: number | null, currency: CurrencyCode): string {
  if (amount == null) return "";
  const c = CURRENCIES[currency];
  return new Intl.NumberFormat(c.format, { minimumFractionDigits: c.decimals, maximumFractionDigits: c.decimals, useGrouping: c.decimals === 0 }).format(
    amount / 10 ** c.decimals,
  );
}

/**
 * Lo que escribió el usuario → unidad mínima. Vacío → null; inválido → undefined.
 * CLP: enteros, con o sin punto de miles ("18.000", "18000"). USD: hasta dos decimales ("18.5", "18,50").
 */
export function parseMoney(text: string, currency: CurrencyCode): number | null | undefined {
  const s = text.trim().replace(/^\$\s*/, "");
  if (!s) return null;
  if (currency === "CLP") {
    if (!/^(\d{1,3}(\.\d{3})+|\d+)$/.test(s)) return undefined;
    return Number(s.replace(/\./g, ""));
  }
  const n = s.replace(",", ".");
  if (!/^\d+(\.\d{1,2})?$/.test(n)) return undefined;
  return Math.round(Number(n) * 100);
}

/** Texto blanco sobre el color del negocio (burbujas del cliente, botones): mínimo AA. */
export const MIN_ACCENT_CONTRAST = 4.5;

/**
 * En modo oscuro, un color casi negro se pierde contra el fondo:
 * se aclara a un gris que mantiene el texto blanco legible.
 */
export function accentForDark(accent: string): string {
  return contrastRatio(accent, BRAND.background.dark) < 1.6 ? "#4F6366" : accent;
}

export const CHAT_PALETTES = [
  { id: "pacifico", es: "Pacífico", en: "Pacific", accent: "#0B6B6B" },
  { id: "rojo", es: "Rojo", en: "Red", accent: "#C62828" },
  { id: "coral", es: "Coral", en: "Coral", accent: "#C2410C" },
  { id: "rosa", es: "Rosa empolvado", en: "Dusty rose", accent: "#B4416A" },
  { id: "salvia", es: "Salvia", en: "Sage", accent: "#3F7056" },
  { id: "oceano", es: "Océano", en: "Ocean", accent: "#1F5F7A" },
  { id: "lavanda", es: "Lavanda", en: "Lavender", accent: "#6B4FA0" },
  { id: "grafito", es: "Grafito", en: "Graphite", accent: "#222222" },
] as const;

/** Texturas curadas del fondo del chat; se dibujan en `.chat-backdrop` (packages/ui/src/styles.css). */
export const CHAT_TEXTURES = [
  { id: "none", es: "Sin textura", en: "No texture" },
  { id: "dots", es: "Puntos", en: "Dots" },
  { id: "lines", es: "Líneas", en: "Lines" },
  { id: "grid", es: "Cuadrícula", en: "Grid" },
] as const;

/** El color con el que se pinta el chat: el de la paleta, o el propio si eligió "custom". */
export function resolveAccent(s: { palette: string; accent: string | null }): string {
  if (s.palette === "custom" && s.accent) return s.accent;
  return CHAT_PALETTES.find((p) => p.id === s.palette)?.accent ?? CHAT_PALETTES[0].accent;
}

export const MAX_CHAT_MESSAGE_CHARS = 2000;
