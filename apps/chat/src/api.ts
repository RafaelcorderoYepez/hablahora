import type { ChatSessionCreated, ChatStreamEvent, ChatTranscript, PublicChatInfo } from "@hablahora/contracts";
import type { Locale } from "./i18n.js";
import { readSse } from "./sse.js";

const base = (slug: string) => `/api/chat/${encodeURIComponent(slug)}`;

export async function getChatInfo(slug: string): Promise<PublicChatInfo | "not_found"> {
  const res = await fetch(base(slug));
  if (res.status === 404) return "not_found";
  if (!res.ok) throw new Error(`chat ${res.status}`);
  return res.json();
}

export async function createSession(
  slug: string,
  locale: Locale,
): Promise<ChatSessionCreated | "rate_limited" | "unavailable"> {
  const res = await fetch(`${base(slug)}/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ locale }),
  });
  if (res.status === 429) return "rate_limited";
  if (res.status === 409) return "unavailable";
  if (!res.ok) throw new Error(`sesión ${res.status}`);
  return res.json();
}

export async function getTranscript(slug: string, sessionId: string): Promise<ChatTranscript | "not_found"> {
  const res = await fetch(`${base(slug)}/sessions/${encodeURIComponent(sessionId)}/messages`);
  if (res.status === 404) return "not_found";
  if (!res.ok) throw new Error(`transcripción ${res.status}`);
  return res.json();
}

export type SendResult = "ok" | "not_found" | "session_limit" | "unavailable" | "error";

/** Envía un mensaje y entrega los eventos de la respuesta a medida que llegan. */
export async function sendMessage(
  slug: string,
  sessionId: string,
  text: string,
  locale: Locale,
  onEvent: (e: ChatStreamEvent) => void,
): Promise<SendResult> {
  const res = await fetch(`${base(slug)}/sessions/${encodeURIComponent(sessionId)}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify({ text, locale }),
  });
  if (res.status === 404) return "not_found";
  if (res.status === 429) return "session_limit";
  if (res.status === 409) return "unavailable";
  if (!res.ok || !res.body) return "error";
  let finished = false;
  for await (const m of readSse(res.body)) {
    let data: unknown = {};
    try {
      data = JSON.parse(m.data);
    } catch {
      continue;
    }
    onEvent({ event: m.event, data } as ChatStreamEvent);
    if (m.event === "done") finished = true;
  }
  return finished ? "ok" : "error";
}
