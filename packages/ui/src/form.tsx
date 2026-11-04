import { forwardRef, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { cn } from "./cn.js";

const control =
  "w-full rounded-lg border border-line bg-raised px-3 py-2 text-[0.9375rem] text-ink placeholder:text-muted focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent disabled:opacity-60 aria-[invalid=true]:border-danger";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...props }, ref) {
  return <input ref={ref} className={cn(control, "h-10", className)} {...props} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea(
  { className, ...props },
  ref,
) {
  return <textarea ref={ref} className={cn(control, "min-h-24", className)} {...props} />;
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select({ className, ...props }, ref) {
  return <select ref={ref} className={cn(control, "h-10 pr-8", className)} {...props} />;
});

/** Etiqueta + control + ayuda o error, con los ids enlazados para lectores de pantalla. */
export function Field(props: { id: string; label: string; hint?: string; error?: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-col gap-1.5", props.className)}>
      <label htmlFor={props.id} className="text-sm font-semibold">
        {props.label}
      </label>
      {props.children}
      {props.error ? (
        <p id={`${props.id}-error`} role="alert" className="text-sm text-danger">
          {props.error}
        </p>
      ) : props.hint ? (
        <p id={`${props.id}-hint`} className="text-sm text-muted">
          {props.hint}
        </p>
      ) : null}
    </div>
  );
}

/** Píldora de estado (rol, estado de una invitación…). */
export function Badge(props: { tone?: "neutral" | "success" | "warning" | "info" | "danger"; children: ReactNode }) {
  const tone = props.tone ?? "neutral";
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold whitespace-nowrap",
        tone === "neutral" && "bg-surface text-muted ring-1 ring-line",
        tone === "success" && "bg-success-bg text-success",
        tone === "warning" && "bg-warning-bg text-warning",
        tone === "info" && "bg-info-bg text-info",
        tone === "danger" && "bg-danger-bg text-danger",
      )}
    >
      {props.children}
    </span>
  );
}

/** Interruptor de encendido/apagado (Radix Switch), con su etiqueta. */
export { SwitchField } from "./switch.js";
