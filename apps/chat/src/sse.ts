export interface SseMessage {
  event: string;
  data: string;
}

/**
 * Lee Server-Sent Events de un cuerpo de respuesta. EventSource solo hace GET,
 * y el mensaje del chat va por POST: por eso se lee el stream a mano.
 * Los eventos pueden llegar partidos en varios fragmentos de red.
 */
export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseMessage> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      // stream: true conserva los caracteres partidos entre fragmentos (tildes, emojis)
      if (value) buffer += decoder.decode(value, { stream: true });
      if (done) buffer += decoder.decode();
      let match: RegExpExecArray | null;
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        const block = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        const message = parseBlock(block);
        if (message) yield message;
      }
      if (done) break;
    }
    const last = parseBlock(buffer);
    if (last) yield last;
  } finally {
    reader.releaseLock();
  }
}

function parseBlock(block: string): SseMessage | null {
  let event = "message";
  const data: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (!line || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }
  return data.length ? { event, data: data.join("\n") } : null;
}
