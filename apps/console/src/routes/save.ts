import { useMutation, useQueryClient, type QueryKey } from "@tanstack/react-query";
import type { FieldValues, Path, UseFormReturn } from "react-hook-form";
import { toast } from "sonner";
import { ApiError, errorText } from "../api.js";
import { useI18n } from "../i18n.js";
import { readinessQuery } from "../queries.js";

/**
 * Guardar en la API: aviso "Guardado", errores explicados en el idioma de la
 * consola (y por campo si la API dice cuál), y refresca lo que dependa.
 */
export function useSave<TInput, TResult>(opts: {
  mutation: (input: TInput) => Promise<TResult>;
  /** consulta cuyo dato reemplaza la respuesta */
  updates?: QueryKey;
  /** consultas a recargar después */
  invalidates?: QueryKey[];
  form?: UseFormReturn<FieldValues>;
  successText?: string | ((result: TResult) => string);
}) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: opts.mutation,
    onSuccess: async (result) => {
      if (opts.updates) queryClient.setQueryData(opts.updates, result);
      await Promise.all(
        [...(opts.invalidates ?? []), readinessQuery.queryKey].map((queryKey) => queryClient.invalidateQueries({ queryKey })),
      );
      const text = typeof opts.successText === "function" ? opts.successText(result) : opts.successText;
      toast.success(text ?? t.cfg.common.saved);
    },
    onError: (err) => {
      if (opts.form && err instanceof ApiError && err.issues?.length) {
        for (const issue of err.issues) opts.form.setError(issue.path as Path<FieldValues>, { message: issue.message });
      }
      toast.error(errorText(err, t.cfg.errors, t.common.genericError));
    },
  });
}

