import type { SVGProps } from "react";

// Logo de la marca (docs/marca/hablahora-icon.svg): un globo de conversación con las
// manecillas de un reloj. Provisorio: para cambiarlo basta este archivo y los favicon.svg.
const BUBBLE =
  "M16 4H32A12 12 0 0 1 44 16V26A12 12 0 0 1 32 38H19L10.2 44.6C9 45.5 7.4 44.5 7.7 43L9 36.2A12 12 0 0 1 4 26V16A12 12 0 0 1 16 4Z";

/** El ícono solo (encabezados compactos, carga del chat). El globo toma el color del texto. */
export function BrandMark({ title, ...props }: SVGProps<SVGSVGElement> & { title?: string }) {
  return (
    <svg viewBox="0 0 48 48" role={title ? "img" : undefined} aria-hidden={title ? undefined : true} {...props}>
      {title ? <title>{title}</title> : null}
      <path d={BUBBLE} fill="currentColor" />
      <path d="M24 21V12.5M24 21H31.5" fill="none" stroke="#ffffff" strokeWidth={3.6} strokeLinecap="round" />
      <circle cx="24" cy="21" r="2.7" fill="var(--ui-highlight)" />
    </svg>
  );
}

/**
 * "hablahora": el ícono y la palabra en la fuente de títulos. En color, el ícono y "hora" van
 * en el color de la marca y "habla" en el del texto; `mono` lo pinta todo del color del texto.
 */
export function BrandWordmark({ className, mono = false }: { className?: string; mono?: boolean }) {
  return (
    <span
      role="img"
      aria-label="HablaHora"
      className={["inline-flex items-center gap-[0.28em] font-display font-extrabold leading-none tracking-[-0.03em]", className]
        .filter(Boolean)
        .join(" ")}
    >
      <BrandMark className={mono ? undefined : "text-brand"} style={{ height: "1.05em", width: "1.05em", flex: "none" }} />
      <span aria-hidden>
        habla<span className={mono ? undefined : "text-brand-text"}>hora</span>
      </span>
    </span>
  );
}
