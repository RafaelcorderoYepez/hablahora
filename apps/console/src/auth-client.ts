import { adminClient, inferAdditionalFields, organizationClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

// Cliente oficial de Better Auth: ingreso, contraseñas, organización (miembros, invitaciones).
// Mismo origen que la API (/api/auth), así la cookie de sesión viaja sola.
export const authClient = createAuthClient({
  basePath: "/api/auth",
  // fetch se busca en cada llamada (no al importar): así los tests pueden simular la API
  fetchOptions: { customFetchImpl: (input, init) => fetch(input, init) },
  plugins: [
    organizationClient(),
    adminClient(),
    inferAdditionalFields({ user: { locale: { type: "string", required: false } } }),
  ],
});

/** Error de Better Auth → código (para mostrar el texto en el idioma de la consola). */
export function authErrorCode(error: { code?: string; status?: number } | null | undefined): string {
  return error?.code ?? (error?.status ? `HTTP_${error.status}` : "UNKNOWN");
}
