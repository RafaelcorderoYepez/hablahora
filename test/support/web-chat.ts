import type { FastifyInstance } from "fastify";
import { expect } from "vitest";

export type SseEvent = { event: string; data: any };

export function parseSse(body: string): SseEvent[] {
  return body
    .split("\n\n")
    .filter((chunk) => chunk.trim())
    .map((chunk) => {
      const event = /^event: (.*)$/m.exec(chunk)![1];
      const data = JSON.parse(/^data: (.*)$/m.exec(chunk)![1]);
      return { event, data };
    });
}

/** Cliente del chat web contra el servidor de Fastify (sin red). */
export function chatClient(app: FastifyInstance, defaultSlug: string) {
  return {
    async newSession(slug = defaultSlug): Promise<string> {
      const res = await app.inject({ method: "POST", url: `/api/chat/${slug}/sessions` });
      expect(res.statusCode).toBe(201);
      return res.json().sessionId;
    },

    /** Envía un mensaje y devuelve los eventos SSE y el texto de la respuesta, ya unido. */
    async send(sessionId: string, text: string, slug = defaultSlug) {
      const res = await app.inject({
        method: "POST",
        url: `/api/chat/${slug}/sessions/${sessionId}/messages`,
        payload: { text },
      });
      const events = res.statusCode === 200 ? parseSse(res.body) : [];
      const reply = events
        .filter((e) => e.event === "text")
        .map((e) => e.data.text)
        .join("");
      return { res, events, reply };
    },
  };
}
