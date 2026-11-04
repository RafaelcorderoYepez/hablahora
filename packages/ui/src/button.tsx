import { cva, type VariantProps } from "class-variance-authority";
import type { ButtonHTMLAttributes } from "react";
import { cn } from "./cn.js";

// Botón al estilo shadcn/ui, con los colores de la marca.
export const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 rounded-lg font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        accent: "bg-accent text-white hover:brightness-95",
        brand: "bg-brand text-white hover:bg-brand-strong",
        outline: "border border-line bg-transparent text-ink hover:bg-surface",
        ghost: "bg-transparent text-ink hover:bg-surface",
      },
      size: {
        sm: "h-8 px-3 text-sm",
        md: "h-10 px-4 text-[0.9375rem]",
        icon: "h-10 w-10",
      },
    },
    defaultVariants: { variant: "accent", size: "md" },
  },
);

export function Button({
  className,
  variant,
  size,
  type = "button",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof buttonVariants>) {
  return <button type={type} className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}
