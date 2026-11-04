import type { FastifyInstance } from "fastify";
import { parseWebhook, verifySignature, type BackgroundTasks, type InboundProcessor } from "@hablahora/core";

export interface WhatsAppRoutesOptions {
  processor: InboundProcessor;
  appSecret: string; // App Secret de la app de Meta (firma de webhooks)
  verifyToken: string; // el que configuras en el panel de Meta al suscribir el webhook
  background: BackgroundTasks;
}

export function whatsappRoutes(app: FastifyInstance, opts: WhatsAppRoutesOptions): void {
  // Guardar el cuerpo crudo: la firma se calcula sobre los bytes originales.
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (req, body, done) => {
    (req as any).rawBody = body;
    try {
      done(null, body.length ? JSON.parse(body.toString("utf8")) : {});
    } catch (err) {
      (err as any).statusCode = 400;
      done(err as Error, undefined);
    }
  });

  // Verificación inicial que hace Meta al suscribir el webhook
  app.get("/webhook", async (req, reply) => {
    const q = req.query as Record<string, string>;
    if (q["hub.mode"] === "subscribe" && q["hub.verify_token"] === opts.verifyToken) {
      return reply.type("text/plain").send(q["hub.challenge"]);
    }
    return reply.code(403).send();
  });

  app.post("/webhook", async (req, reply) => {
    const raw: Buffer = (req as any).rawBody ?? Buffer.alloc(0);
    if (!verifySignature(raw, req.headers["x-hub-signature-256"] as string | undefined, opts.appSecret)) {
      return reply.code(401).send();
    }
    // Responder 200 de inmediato: Meta reintenta si tardamos, y el agente puede demorar segundos.
    for (const msg of parseWebhook(req.body)) {
      opts.background.track(
        opts.processor.process(msg).catch((err) => app.log.error({ err, msg: msg.waMessageId }, "inbound falló")),
      );
    }
    return reply.code(200).send();
  });
}
