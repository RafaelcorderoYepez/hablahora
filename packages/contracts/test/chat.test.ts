import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  accentForDark,
  CHAT_PALETTES,
  CHAT_TEXTURES,
  ChatSettings,
  ChatTexture,
  contrastRatio,
  DEFAULT_CHAT_SETTINGS,
  MIN_ACCENT_CONTRAST,
  resolveAccent,
} from "../src/index.js";

describe("paleta de la marca y del chat", () => {
  it("el contraste coincide con WCAG", () => {
    expect(contrastRatio("#000000", "#FFFFFF")).toBeCloseTo(21, 5);
    expect(contrastRatio("#FFFFFF", "#0B6B6B")).toBeCloseTo(6.31, 1); // blanco sobre Pacífico
    expect(contrastRatio("#0B6B6B", "#F3F6F5")).toBeGreaterThanOrEqual(4.5); // Pacífico para texto sobre Bruma
    expect(contrastRatio("#5FC4BE", "#0E1B1D")).toBeGreaterThanOrEqual(4.5); // Pacífico para texto en oscuro
    expect(contrastRatio("#5B6F70", "#F3F6F5")).toBeGreaterThanOrEqual(4.5); // texto secundario
    expect(contrastRatio("#9DB2B1", "#1A2E32")).toBeGreaterThanOrEqual(4.5); // texto secundario en oscuro
  });

  it("todas las paletas curadas llevan texto blanco legible", () => {
    for (const p of CHAT_PALETTES) {
      expect(contrastRatio("#FFFFFF", p.accent), p.id).toBeGreaterThanOrEqual(MIN_ACCENT_CONTRAST);
    }
  });

  it("en oscuro el grafito se aclara para no perderse contra el fondo", () => {
    expect(accentForDark("#222222")).not.toBe("#222222");
    expect(contrastRatio("#FFFFFF", accentForDark("#222222"))).toBeGreaterThanOrEqual(MIN_ACCENT_CONTRAST);
    expect(accentForDark("#0B6B6B")).toBe("#0B6B6B");
  });

  it("valores por defecto y color propio", () => {
    expect(DEFAULT_CHAT_SETTINGS).toEqual({ palette: "pacifico", accent: null, appearance: "auto", tint: false, texture: "none", welcome: { es: null, en: null } });
    expect(resolveAccent(DEFAULT_CHAT_SETTINGS)).toBe("#0B6B6B");
    expect(resolveAccent({ palette: "custom", accent: "#1F5F7A" })).toBe("#1F5F7A");
    expect(ChatSettings.safeParse({ palette: "custom", accent: "#F5E0A0" }).success).toBe(false);
    expect(ChatSettings.safeParse({ palette: "custom" }).success).toBe(false);
    expect(ChatSettings.safeParse({ palette: "violeta" }).success).toBe(false);
  });

  it("los ajustes guardados antes del fondo configurable siguen valiendo, y solo se aceptan las texturas curadas", () => {
    expect(ChatSettings.parse({ palette: "rosa", appearance: "dark" })).toMatchObject({ tint: false, texture: "none" });
    expect(CHAT_TEXTURES.map((t) => t.id)).toEqual(ChatTexture.options);
    expect(ChatSettings.safeParse({ texture: "url(https://ejemplo.cl/x.png)" }).success).toBe(false);
  });
});

describe("fondo del chat: lo que va encima sigue legible", () => {
  const css = readFileSync(fileURLToPath(new URL("../../ui/src/styles.css", import.meta.url)), "utf8");
  const block = (selector: string) => css.slice(css.indexOf(selector)).split("}")[0];
  const light = block(":root,\n.light");
  const dark = block("\n.dark {");
  const value = (b: string, name: string) => {
    const m = new RegExp(`${name}:\\s*([^;]+);`).exec(b);
    if (!m) throw new Error(`falta ${name} en styles.css`);
    return m[1].trim();
  };
  const percent = (text: string) => Number(/(\d+)%/.exec(text)?.[1]) / 100;
  const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const mix = (top: string, bottom: string, amount: number) =>
    `#${rgb(top)
      .map((c, i) => Math.round(c * amount + rgb(bottom)[i] * (1 - amount)).toString(16).padStart(2, "0"))
      .join("")}`;

  // negro: el color propio más oscuro que se puede elegir; es el que más baja el contraste en claro
  const accents = [...CHAT_PALETTES.map((p) => p.accent as string), "#000000"];
  const modes = [
    {
      name: "claro",
      bg: "#f3f6f5",
      raised: value(light, "--ui-raised"),
      muted: value(light, "--ui-muted"),
      texts: [value(light, "--ui-info"), value(light, "--ui-danger")],
      tint: percent(value(light, "--ui-chat-tint")),
      textureAmount: percent(value(light, "--ui-chat-texture")),
      accent: (a: string) => a,
      texture: (a: string) => a,
    },
    {
      name: "oscuro",
      bg: value(dark, "--ui-bg"),
      raised: value(dark, "--ui-raised"),
      muted: value(dark, "--ui-muted"),
      texts: [value(dark, "--ui-info"), value(dark, "--ui-danger")],
      tint: percent(value(dark, "--ui-chat-tint")),
      textureAmount: percent(value(dark, "--ui-chat-texture")),
      accent: accentForDark,
      texture: () => value(dark, "--ui-ink"),
    },
  ];

  for (const m of modes) {
    it(`en ${m.name}, el equipo y los errores se leen sobre el tinte y la textura, en su punto más cargado`, () => {
      expect(m.tint).toBeGreaterThan(0);
      expect(m.textureAmount).toBeGreaterThan(0);
      for (const accent of accents) {
        const tinted = mix(m.accent(accent), m.bg, m.tint);
        const worst = mix(m.texture(m.accent(accent)), tinted, m.textureAmount);
        for (const text of m.texts) {
          expect(contrastRatio(text, worst), `${text} sobre ${worst} (${accent})`).toBeGreaterThanOrEqual(4.5);
        }
      }
    });

    it(`en ${m.name}, el texto secundario va sobre su píldora y no depende del fondo`, () => {
      expect(contrastRatio(m.muted, m.raised)).toBeGreaterThanOrEqual(4.5);
    });
  }
});
