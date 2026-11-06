import { z } from "zod";
import { Locale } from "./common.js";

import {
  accentForDark,
  BRAND,
  CHAT_PALETTES,
  CHAT_TEXTURES,
  COUNTRIES,
  COUNTRY_CODES,
  CURRENCIES,
  formatMoney,
  formatMoneyInput,
  parseMoney,
  contrastRatio,
  MAX_CHAT_MESSAGE_CHARS,
  MIN_ACCENT_CONTRAST,
  relativeLuminance,
  resolveAccent,
} from "./browser.js";
export type { CountryCode, CurrencyCode } from "./browser.js";

export {
  accentForDark,
  BRAND,
  CHAT_PALETTES,
  CHAT_TEXTURES,
  COUNTRIES,
  COUNTRY_CODES,
  CURRENCIES,
  formatMoney,
  formatMoneyInput,
  parseMoney,
  contrastRatio,
  MAX_CHAT_MESSAGE_CHARS,
  MIN_ACCENT_CONTRAST,
  relativeLuminance,
  resolveAccent,
};

export const HexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Color inválido (formato #RRGGBB)");

export const PaletteId = z.enum(["pacifico", "rojo", "coral", "rosa", "salvia", "oceano", "lavanda", "grafito", "custom"]);
export type PaletteId = z.infer<typeof PaletteId>;

export const Appearance = z.enum(["light", "dark", "auto"]);
export type Appearance = z.infer<typeof Appearance>;

export const ChatTexture = z.enum(["none", "dots", "lines", "grid"]);
export type ChatTexture = z.infer<typeof ChatTexture>;

const Welcome = z.string().trim().min(1).max(300).nullable();

export const ChatSettings = z
  .object({
    /** paleta curada, o "custom" con un color propio en `accent` */
    palette: PaletteId.default("pacifico"),
    accent: HexColor.nullable().default(null),
    /** "auto" = como el dispositivo del cliente */
    appearance: Appearance.default("auto"),
    /** fondo teñido con el color del negocio */
    tint: z.boolean().default(false),
    /** textura curada sobre el fondo */
    texture: ChatTexture.default("none"),
    /** mensaje de bienvenida por idioma; null = uno genérico con el nombre del negocio */
    welcome: z.object({ es: Welcome.default(null), en: Welcome.default(null) }).strict().default({ es: null, en: null }),
  })
  .strict()
  .refine((s) => s.palette !== "custom" || s.accent !== null, {
    message: "Con un color propio, indica el color",
    path: ["accent"],
  })
  .refine((s) => s.palette !== "custom" || !s.accent || contrastRatio("#FFFFFF", s.accent) >= MIN_ACCENT_CONTRAST, {
    message: `Ese color es muy claro: el texto blanco encima no se lee (necesita contraste ${MIN_ACCENT_CONTRAST}:1)`,
    path: ["accent"],
  });
export type ChatSettings = z.infer<typeof ChatSettings>;

export const DEFAULT_CHAT_SETTINGS: ChatSettings = ChatSettings.parse({});

// ---------------------------------------------------------------------
// API pública del chat (sin login)
// ---------------------------------------------------------------------

/** GET /api/chat/:slug: lo necesario para pintar el chat antes de abrir una sesión. */
export const PublicChatInfo = z.object({
  name: z.string(),
  /** false: el negocio todavía no activó su chat */
  available: z.boolean(),
  /** idioma por defecto del negocio */
  locale: Locale,
  accent: HexColor,
  appearance: Appearance,
  tint: z.boolean(),
  texture: ChatTexture,
  welcome: z.object({ es: z.string().nullable(), en: z.string().nullable() }),
  /** logo del negocio (URL con versión); null = iniciales con el color del negocio */
  logoUrl: z.string().nullable(),
  /** hay aviso de privacidad: el chat muestra el enlace */
  privacy: z.boolean(),
});
export type PublicChatInfo = z.infer<typeof PublicChatInfo>;

/** GET /api/privacy: aviso de privacidad del chat (texto de la plataforma). */
export const PrivacyNotice = z.object({ es: z.string().nullable(), en: z.string().nullable(), updatedAt: z.string().nullable() });
export type PrivacyNotice = z.infer<typeof PrivacyNotice>;

export const ChatSessionCreate = z.object({ locale: Locale.optional() }).strict();
export type ChatSessionCreate = z.infer<typeof ChatSessionCreate>;

export const ChatSessionCreated = z.object({ sessionId: z.string(), locale: Locale });
export type ChatSessionCreated = z.infer<typeof ChatSessionCreated>;

export const ChatMessageBody = z
  .object({
    text: z.string().trim().min(1).max(MAX_CHAT_MESSAGE_CHARS),
    /** si el cliente cambió el idioma con el selector */
    locale: Locale.optional(),
  })
  .strict();
export type ChatMessageBody = z.infer<typeof ChatMessageBody>;

/** GET /api/chat/:slug/sessions/:id/messages: la conversación visible (sin herramientas). */
export const ChatTranscript = z.object({
  locale: Locale,
  /** la conversación pasó a una persona del negocio */
  handoff: z.boolean(),
  messages: z.array(
    z.object({
      role: z.enum(["customer", "agent", "staff"]),
      text: z.string(),
      at: z.string(),
    }),
  ),
});
export type ChatTranscript = z.infer<typeof ChatTranscript>;

/** Eventos SSE de POST /api/chat/:slug/sessions/:id/messages. */
export type ChatStreamEvent =
  | { event: "text"; data: { text: string } }
  | { event: "tool"; data: { name: string } }
  | { event: "handoff"; data: Record<string, never> }
  | { event: "error"; data: { message: string } }
  | { event: "done"; data: Record<string, never> };
