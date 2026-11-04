import { describe, expect, it } from "vitest";
import { readSse } from "./sse.js";

/** Cuerpo de respuesta que llega en los fragmentos indicados (como por la red). */
function body(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      c.close();
    },
  });
}

const collect = async (chunks: string[]) => {
  const out = [];
  for await (const m of readSse(body(chunks))) out.push(m);
  return out;
};

describe("readSse", () => {
  it("lee eventos aunque lleguen partidos en cualquier punto", async () => {
    const raw = 'event: text\ndata: {"text":"Hola, ¿qué tal?"}\n\nevent: tool\ndata: {"name":"check_availability"}\n\nevent: done\ndata: {}\n\n';
    const whole = await collect([raw]);
    expect(whole).toEqual([
      { event: "text", data: '{"text":"Hola, ¿qué tal?"}' },
      { event: "tool", data: '{"name":"check_availability"}' },
      { event: "done", data: "{}" },
    ]);
    // de a un carácter: la misma secuencia
    expect(await collect(raw.split(""))).toEqual(whole);
  });

  it("no rompe caracteres de varios bytes partidos entre fragmentos", async () => {
    const bytes = new TextEncoder().encode('event: text\ndata: {"text":"ñ"}\n\n');
    const enc = (b: Uint8Array) => new TextDecoder().decode(b); // solo para armar los fragmentos
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        const cut = bytes.indexOf(0xc3) + 1; // mitad de la ñ
        c.enqueue(bytes.slice(0, cut));
        c.enqueue(bytes.slice(cut));
        c.close();
      },
    });
    const out = [];
    for await (const m of readSse(stream)) out.push(m);
    expect(out).toEqual([{ event: "text", data: '{"text":"ñ"}' }]);
    expect(enc(bytes)).toContain("ñ");
  });

  it("ignora comentarios y une varias líneas de datos; acepta \\r\\n", async () => {
    expect(await collect([": ping\r\n\r\nevent: x\r\ndata: a\r\ndata: b\r\n\r\n"])).toEqual([{ event: "x", data: "a\nb" }]);
  });
});
