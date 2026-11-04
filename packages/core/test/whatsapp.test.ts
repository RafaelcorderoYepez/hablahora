import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { normalizeHistory, parseWebhook, splitForWhatsApp, verifySignature } from "../src/index.js";
import { KeyedQueue } from "../src/util/keyed-queue.js";
import { waPayload } from "../../../test/support/wa-payload.js";

const sign = (body: string, secret: string) => "sha256=" + createHmac("sha256", secret).update(body).digest("hex");

describe("firma del webhook", () => {
  it("acepta la firma correcta y rechaza las demás", () => {
    const body = JSON.stringify({ hola: "mundo" });
    expect(verifySignature(Buffer.from(body), sign(body, "s3cret"), "s3cret")).toBe(true);
    expect(verifySignature(Buffer.from(body), sign(body, "otro"), "s3cret")).toBe(false);
    expect(verifySignature(Buffer.from(body + " "), sign(body, "s3cret"), "s3cret")).toBe(false);
    expect(verifySignature(Buffer.from(body), undefined, "s3cret")).toBe(false);
    expect(verifySignature(Buffer.from(body), "sha256=abc", "s3cret")).toBe(false);
  });
});

describe("parseo", () => {
  it("extrae texto, número del negocio, cliente en E.164 y nombre de perfil", () => {
    const [m] = parseWebhook(waPayload({ phoneNumberId: "wa-111", from: "13055551234", id: "wamid.1", text: " Hola " }));
    expect(m).toMatchObject({
      phoneNumberId: "wa-111",
      from: "+13055551234",
      waMessageId: "wamid.1",
      kind: "text",
      text: "Hola",
      profileName: "Rafa",
    });
  });

  it("marca audio y otros tipos como no soportados", () => {
    const [m] = parseWebhook(waPayload({ phoneNumberId: "x", from: "1", id: "w", type: "audio" }));
    expect(m.kind).toBe("unsupported");
  });

  it("ignora notificaciones de estado", () => {
    const body = {
      object: "whatsapp_business_account",
      entry: [{ changes: [{ field: "messages", value: { metadata: { phone_number_id: "x" }, statuses: [{ id: "w", status: "read" }] } }] }],
    };
    expect(parseWebhook(body)).toEqual([]);
  });
});

describe("mensajes largos", () => {
  it("corta en trozos de hasta 4096 caracteres respetando párrafos", () => {
    const text = Array.from({ length: 30 }, (_, i) => `Párrafo ${i} `.repeat(30)).join("\n\n");
    const parts = splitForWhatsApp(text);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((p) => p.length <= 4096)).toBe(true);
    expect(parts.join(" ").replace(/\s+/g, " ")).toBe(text.replace(/\s+/g, " ").trim());
  });
});

describe("historial", () => {
  it("descarta un tool_use sin respuesta (crash a mitad de vuelta)", () => {
    const h = normalizeHistory([
      { role: "user", content: [{ type: "text", text: "mesa para 2" }] },
      { role: "assistant", content: [{ type: "text", text: "Busco..." }, { type: "tool_use", id: "t1", name: "x", input: {} }] },
      { role: "user", content: [{ type: "text", text: "¿hola?" }] },
    ] as any);
    expect(JSON.stringify(h)).not.toContain("tool_use");
    expect(h.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
  });

  it("fusiona mensajes seguidos del cliente y empieza siempre por el cliente", () => {
    const h = normalizeHistory([
      { role: "user", content: [{ type: "tool_result", tool_use_id: "viejo", content: "{}" }] },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
      { role: "user", content: [{ type: "text", text: "uno" }] },
      { role: "user", content: [{ type: "text", text: "dos" }] },
    ] as any);
    expect(h).toHaveLength(1);
    expect(h[0].content).toHaveLength(2);
  });

  it("conserva pares completos", () => {
    const msgs = [
      { role: "user", content: [{ type: "text", text: "hola" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "x", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "{}" }] },
      { role: "assistant", content: [{ type: "text", text: "listo" }] },
    ];
    expect(normalizeHistory(msgs as any)).toEqual(msgs);
  });
});

describe("cola por conversación", () => {
  it("procesa de a uno por clave y en paralelo entre claves", async () => {
    const q = new KeyedQueue();
    const log: string[] = [];
    let running = 0;
    let maxSameKey = 0;
    const task = (key: string, id: string, ms: number) =>
      q.run(key, async () => {
        if (key === "a") maxSameKey = Math.max(maxSameKey, ++running);
        log.push(`start ${id}`);
        await new Promise((r) => setTimeout(r, ms));
        log.push(`end ${id}`);
        if (key === "a") running--;
      });
    await Promise.all([task("a", "a1", 30), task("a", "a2", 5), task("b", "b1", 5)]);
    expect(maxSameKey).toBe(1);
    expect(log.indexOf("end a1")).toBeLessThan(log.indexOf("start a2"));
    expect(log.indexOf("end b1")).toBeLessThan(log.indexOf("end a1"));
  });

  it("un error no traba la cola", async () => {
    const q = new KeyedQueue();
    await expect(q.run("k", async () => { throw new Error("x"); })).rejects.toThrow("x");
    await expect(q.run("k", async () => 42)).resolves.toBe(42);
  });
});
