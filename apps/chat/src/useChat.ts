import type { ChatStreamEvent, PublicChatInfo } from "@hablahora/contracts";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createSession, getChatInfo, getTranscript, sendMessage } from "./api.js";
import { detectLocale, type Locale } from "./i18n.js";
import { storage } from "./storage.js";
import { applyTheme } from "./theme.js";

export interface ChatMessage {
  id: string;
  role: "customer" | "agent" | "staff";
  text: string;
  /** el mensaje del cliente no llegó (límite, error de red) */
  failed?: boolean;
}

export type Notice = "session_limit" | "rate_limited" | "send_error" | null;

export type ChatState =
  | { phase: "loading" }
  | { phase: "not_found" }
  | { phase: "unavailable"; info: PublicChatInfo }
  | { phase: "load_error" }
  | { phase: "ready"; info: PublicChatInfo };

/** Cada cuánto se buscan respuestas del equipo durante el paso a humano. */
export const HANDOFF_POLL_MS = 5000;

let seq = 0;
const nextId = () => `m${++seq}`;

/** Estado y acciones del chat de un negocio. */
export function useChat(slug: string) {
  const [state, setState] = useState<ChatState>({ phase: "loading" });
  const [locale, setLocaleState] = useState<Locale>("es");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  /** null: el agente no está trabajando; "thinking" o el nombre de la herramienta en uso */
  const [working, setWorking] = useState<string | null>(null);
  const [handoff, setHandoff] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState(false);
  const sessionRef = useRef<string | undefined>(undefined);
  const busyRef = useRef(false);

  const load = useCallback(async () => {
    setState({ phase: "loading" });
    try {
      const info = await getChatInfo(slug);
      if (info === "not_found") return setState({ phase: "not_found" });
      if (!info.available) {
        setLocaleState(storage.get(slug).locale ?? detectLocale(navigator.languages ?? [navigator.language], info.locale));
        return setState({ phase: "unavailable", info });
      }
      const stored = storage.get(slug);
      let lang: Locale = stored.locale ?? detectLocale(navigator.languages ?? [navigator.language], info.locale);

      // retomar la conversación si el navegador recuerda una
      if (stored.sessionId) {
        const transcript = await getTranscript(slug, stored.sessionId);
        if (transcript === "not_found") {
          storage.setSession(slug, undefined);
        } else {
          sessionRef.current = stored.sessionId;
          lang = stored.locale ?? transcript.locale;
          setMessages(transcript.messages.map((m) => ({ id: nextId(), role: m.role, text: m.text })));
          setHandoff(transcript.handoff);
        }
      }
      setLocaleState(lang);
      setState({ phase: "ready", info });
    } catch {
      setState({ phase: "load_error" });
    }
  }, [slug]);

  useEffect(() => {
    void load();
  }, [load]);

  const info = state.phase === "ready" || state.phase === "unavailable" ? state.info : null;
  // antes de pintar: que el chat no aparezca un instante con el color por defecto
  useLayoutEffect(() => (info ? applyTheme(info) : undefined), [info]);
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);
  useEffect(() => {
    if (info) document.title = info.name;
  }, [info]);

  // con la conversación en manos del equipo, sus respuestas llegan sin que el cliente escriba:
  // se pide la conversación cada 5 s hasta que el equipo la devuelva al agente
  useEffect(() => {
    if (!handoff || state.phase !== "ready") return;
    const id = setInterval(async () => {
      const sessionId = sessionRef.current;
      if (!sessionId || busyRef.current) return;
      try {
        const transcript = await getTranscript(slug, sessionId);
        if (transcript === "not_found" || busyRef.current) return;
        setMessages((current) => {
          const same =
            current.length === transcript.messages.length &&
            current.every((m, i) => m.text === transcript.messages[i].text && m.role === transcript.messages[i].role);
          return same ? current : transcript.messages.map((m) => ({ id: nextId(), role: m.role, text: m.text }));
        });
        setHandoff(transcript.handoff);
      } catch {
        /* sin conexión: se reintenta en la próxima vuelta */
      }
    }, HANDOFF_POLL_MS);
    return () => clearInterval(id);
  }, [handoff, state.phase, slug]);

  const setLocale = useCallback(
    (l: Locale) => {
      setLocaleState(l);
      storage.setLocale(slug, l); // se guarda en la conversación con el próximo mensaje
    },
    [slug],
  );

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || busyRef.current || state.phase !== "ready") return false;
      busyRef.current = true;
      setBusy(true);
      setNotice(null);
      const customerId = nextId();
      setMessages((ms) => [...ms, { id: customerId, role: "customer", text: trimmed }]);
      const markFailed = () =>
        setMessages((ms) => ms.map((m) => (m.id === customerId ? { ...m, failed: true } : m)));

      try {
        // la sesión se abre con el primer mensaje: ver la página no crea conversaciones
        for (let attempt = 0; attempt < 2; attempt++) {
          if (!sessionRef.current) {
            const created = await createSession(slug, locale);
            if (created === "rate_limited") {
              markFailed();
              setNotice("rate_limited");
              return false;
            }
            if (created === "unavailable") {
              markFailed();
              setState({ phase: "unavailable", info: state.info });
              return false;
            }
            sessionRef.current = created.sessionId;
            storage.setSession(slug, created.sessionId);
          }

          setWorking("thinking");
          let agentId: string | null = null; // burbuja del agente que se está escribiendo
          const onEvent = (e: ChatStreamEvent) => {
            if (e.event === "text") {
              const chunk = e.data.text;
              if (agentId) {
                const id = agentId;
                setMessages((ms) => ms.map((m) => (m.id === id ? { ...m, text: m.text + chunk } : m)));
              } else {
                const id = nextId();
                agentId = id;
                setMessages((ms) => [...ms, { id, role: "agent", text: chunk }]);
              }
              setWorking(null);
            } else if (e.event === "tool") {
              agentId = null; // lo que escriba después de la herramienta va en otra burbuja
              setWorking(e.data.name);
            } else if (e.event === "handoff") {
              setHandoff(true);
            } else if (e.event === "error") {
              setNotice("send_error");
            }
          };

          const result = await sendMessage(slug, sessionRef.current, trimmed, locale, onEvent);
          if (result === "not_found" && attempt === 0) {
            // la sesión guardada ya no existe: se abre una nueva y se reintenta una vez
            sessionRef.current = undefined;
            storage.setSession(slug, undefined);
            continue;
          }
          if (result === "unavailable") {
            markFailed();
            setState({ phase: "unavailable", info: state.info });
            return false;
          }
          if (result === "session_limit") {
            markFailed();
            setNotice("session_limit");
            return false;
          }
          if (result !== "ok") {
            markFailed();
            setNotice("send_error");
            return false;
          }
          return true;
        }
        return false;
      } catch {
        markFailed();
        setNotice("send_error");
        return false;
      } finally {
        setWorking(null);
        busyRef.current = false;
        setBusy(false);
      }
    },
    [slug, locale, state.phase],
  );

  const newConversation = useCallback(() => {
    if (busyRef.current) return;
    sessionRef.current = undefined;
    storage.setSession(slug, undefined);
    setMessages([]);
    setHandoff(false);
    setNotice(null);
  }, [slug]);

  return { state, locale, setLocale, messages, working, busy, handoff, notice, send, newConversation, retry: load };
}
