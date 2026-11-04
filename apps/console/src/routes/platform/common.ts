import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { errorText } from "../../api.js";
import { useI18n } from "../../i18n.js";

/**
 * Costo del modelo: siempre en dólares (lo que cobra Anthropic), marcado como US$ para que en
 * Chile no se lea como pesos. Con los decimales que hagan falta: por conversación son centavos.
 */
export const usd = (n: number, locale: "es" | "en") =>
  `US$${new Intl.NumberFormat(locale === "en" ? "en-US" : "es-CL", { minimumFractionDigits: 2, maximumFractionDigits: n < 1 ? 4 : 2 }).format(n)}`;

/** 1234567 → "1.2 M". */
export const compact = (n: number) => new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(n);

/** Guardar en la API de plataforma: aviso, errores en el idioma de la consola y todo lo de plataforma al día. */
export function usePlatformSave<TInput, TResult>(mutation: (input: TInput) => Promise<TResult>, successText: string | ((r: TResult) => string)) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: mutation,
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: ["platform"] });
      toast.success(typeof successText === "function" ? successText(result) : successText);
    },
    onError: (err) => toast.error(errorText(err, t.platform.errors, t.common.genericError)),
  });
}

/** "1500" → 1500; vacío → null (sin límite); inválido → undefined. */
export function parseLimit(text: string): number | null | undefined {
  const s = text.trim();
  if (!s) return null;
  return /^\d+$/.test(s) && Number(s) > 0 ? Number(s) : undefined;
}
