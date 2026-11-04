import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, type RouterHistory } from "@tanstack/react-router";
import { useState } from "react";
import { Toaster } from "sonner";
import { I18nProvider } from "./i18n.js";
import { makeRouter } from "./router.js";

export function App({ history }: { history?: RouterHistory }) {
  const [queryClient] = useState(() => new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false } } }));
  const [router] = useState(() => makeRouter(queryClient, history));
  return (
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <RouterProvider router={router} />
        <Toaster position="top-center" richColors closeButton toastOptions={{ style: { fontFamily: "inherit" } }} />
      </I18nProvider>
    </QueryClientProvider>
  );
}
