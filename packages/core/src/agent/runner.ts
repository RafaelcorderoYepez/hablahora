import type Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { BookingService, ConversationContext } from "../booking/service.js";
import { withTenant, type Db } from "../db/tenant.js";
import {
  appendMessage,
  getAgentSettings,
  getConversation,
  loadHistory,
  setHandoff,
  forModel,
  type AgentSettings,
  type ConversationRow,
  type HistoryMessage,
  type SystemMessage,
} from "./conversations.js";
import type { EmailCodeService } from "../customers/email-code.js";
import { bookingTools, dateContextLine, emailCodeTools, handleBookingTool, saveCustomerContactTool } from "./tools.js";
import { recordLlmCall, recordToolCall } from "./trace.js";

/**
 * Lo mínimo que el runner necesita del cliente de Claude (fácil de simular en tests).
 * Si recibe `onText`, lo llama con cada fragmento de texto a medida que llega.
 */
export type LlmClient = (
  params: Anthropic.MessageCreateParamsNonStreaming,
  opts?: { onText?: (delta: string) => void },
) => Promise<Anthropic.Message>;

/** Lo que el canal puede mostrar mientras el agente trabaja. */
export type AgentEvent =
  | { type: "text"; text: string } // fragmento de la respuesta
  | { type: "tool"; name: string } // el agente está usando una herramienta (sin entradas: no se exponen)
  | { type: "handoff" }; // la conversación pasó a una persona

export const requestHumanTool = {
  name: "request_human",
  description:
    "Pasa la conversación a una persona del negocio. Úsalo si el cliente lo pide, si está molesto, si pregunta algo que no puedes resolver con la información disponible, o ante reclamos, pagos o pedidos especiales que requieren criterio humano. Después de llamarlo, avisa al cliente que alguien del equipo le responderá por este mismo chat.",
  input_schema: {
    type: "object",
    properties: { reason: { type: "string", description: "Resumen breve para el equipo" } },
    required: ["reason"],
    additionalProperties: false,
  },
} as const;

export interface AgentRunnerOptions {
  db: Db;
  bookings: BookingService;
  /** chat web: códigos por email para gestionar reservas de otras sesiones */
  emailCodes?: EmailCodeService;
  llm: LlmClient;
  model: string;
  clock?: () => Date;
  maxToolRounds?: number;
  /** incluye el pensamiento del modelo (Sonnet 5.5 piensa por defecto) */
  maxTokens?: number;
  /** esfuerzo del modelo; sin definir, el valor por defecto del modelo */
  effort?: Effort;
  /** aviso al negocio cuando el agente pide un humano (email, Slack, panel...) */
  onHandoff?: (conv: ConversationRow, reason: string) => void | Promise<void>;
  /** dónde registrar fallas internas (una herramienta que lanza); por defecto, la consola */
  log?: Pick<Console, "error">;
}

export interface IncomingText {
  conversationId: string;
  tenantId: string;
  text: string;
  waMessageId?: string;
  onEvent?: (event: AgentEvent) => void;
}

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

// Solo cuando la conversación de verdad pasó a una persona (ver run()).
const HANDOFF_FALLBACK = {
  es: "Disculpa, no pude completar eso. Te comunico con alguien del equipo para que te ayude por este mismo chat.",
  en: "Sorry, I couldn't complete that. I'm connecting you with someone from our team who will reply here.",
};

// Falla del modelo o de la API: no promete nada que no pasó.
const ERROR_REPLY = {
  es: "Tuve un problema para responderte. ¿Me lo escribes de nuevo en un momento?",
  en: "I had trouble replying just now. Could you send that again in a moment?",
};

export class AgentRunner {
  private clock: () => Date;
  private maxToolRounds: number;
  private maxTokens: number;

  constructor(private opts: AgentRunnerOptions) {
    this.clock = opts.clock ?? (() => new Date());
    this.maxToolRounds = opts.maxToolRounds ?? 8;
    this.maxTokens = opts.maxTokens ?? 4096;
  }

  /**
   * Procesa un mensaje de texto del cliente y devuelve los textos a enviarle.
   * Si la conversación está en manos de una persona, solo guarda el mensaje.
   * Debe llamarse de a un mensaje por conversación (ver KeyedQueue).
   */
  async handleCustomerText(msg: IncomingText): Promise<string[]> {
    const { db } = this.opts;
    const setup = await withTenant(db, msg.tenantId, async (tx) => {
      const conv = await getConversation(tx, msg.conversationId);
      if (!conv) throw new Error(`Conversación ${msg.conversationId} no encontrada`);
      await appendMessage(tx, conv, { role: "user", content: msg.text }, "customer", msg.waMessageId);
      if (conv.handoff) return { conv, settings: null, history: [] };
      const settings = await getAgentSettings(tx, conv.locationId);
      const history = await loadHistory(tx, conv.id);
      return { conv, settings, history };
    });
    if (!setup.settings) return []; // atiende un humano
    return this.run(setup.conv, setup.settings, setup.history, msg.onEvent ?? (() => {}));
  }

  private async run(
    conv: ConversationRow,
    settings: AgentSettings,
    history: HistoryMessage[],
    emit: (event: AgentEvent) => void,
  ): Promise<string[]> {
    const ctx: ConversationContext = {
      tenantId: conv.tenantId,
      locationId: conv.locationId,
      conversationId: conv.id,
      channel: conv.channel,
      customerId: conv.customerId,
      // en WhatsApp el número que escribe está probado por el canal
      verifiedPhone: conv.channel === "whatsapp" ? conv.externalId : undefined,
      verifiedEmail: conv.verifiedEmail,
    };
    const turnId = randomUUID();
    const model = settings.model ?? this.opts.model;
    // la hora del turno es una sola: así el contexto no cambia entre vueltas del mismo turno
    const now = this.clock();
    const system = this.systemPrompt(conv, settings);
    let context = this.contextMessage(conv, settings, now);
    const messages: HistoryMessage[] = [...history, context];
    // los mensajes de sistema se guardan junto con la respuesta que los sigue (si el turno
    // falla antes, no quedan sueltos en el historial)
    const pending: SystemMessage[] = [context];
    const flush = async () => {
      for (const m of pending.splice(0)) await this.persist(conv, m, "system");
    };
    const tools = [
      ...bookingTools,
      ...(conv.channel === "web" ? [saveCustomerContactTool] : []),
      ...(conv.channel === "web" && this.opts.emailCodes ? emailCodeTools : []),
      requestHumanTool,
    ] as unknown as Anthropic.Tool[];

    for (let round = 0; round < this.maxToolRounds; round++) {
      const params: Anthropic.MessageCreateParamsNonStreaming = {
        model,
        max_tokens: this.maxTokens,
        ...(this.opts.effort ? { output_config: { effort: this.opts.effort } } : {}),
        system,
        tools,
        messages: forModel(messages, model),
      };
      let streamed = false;
      const started = performance.now();
      let response: Anthropic.Message;
      try {
        response = await this.opts.llm(params, {
          onText: (text) => {
            streamed = true;
            emit({ type: "text", text });
          },
        });
      } catch (err) {
        await this.recordCall(conv, turnId, model, { durationMs: performance.now() - started, error: describeError(err) });
        throw err;
      }
      const llmUsageId = await this.recordCall(conv, turnId, model, { durationMs: performance.now() - started, response });
      if (response.stop_reason === "max_tokens") {
        console.warn(`[agent] respuesta cortada por max_tokens (${this.maxTokens}) en la conversación ${conv.id}`);
      }
      // un cliente sin streaming (o el LLM simulado) entrega el texto de una vez
      if (!streamed) {
        for (const b of response.content) if (b.type === "text" && b.text.trim()) emit({ type: "text", text: b.text });
      }

      const assistant: Anthropic.MessageParam = {
        role: "assistant",
        content: response.content as Anthropic.ContentBlockParam[],
      };
      messages.push(assistant);
      await flush();
      await this.persist(conv, assistant, "agent");

      const toolUses = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
      if (response.stop_reason !== "tool_use" || toolUses.length === 0) {
        return textOf(response);
      }

      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const use of toolUses) {
        emit({ type: "tool", name: use.name });
        const toolStarted = performance.now();
        const result = await this.runTool(conv, ctx, use, emit);
        await withTenant(this.opts.db, conv.tenantId, (tx) =>
          recordToolCall(tx, {
            tenantId: conv.tenantId,
            conversationId: conv.id,
            llmUsageId,
            toolUseId: use.id,
            name: use.name,
            input: use.input,
            result: JSON.parse(result.content as string),
            isError: result.is_error ?? false,
            durationMs: performance.now() - toolStarted,
          }),
        );
        results.push(result);
      }
      // save_customer_contact pudo asociar un cliente: el modelo lo sabe por un contexto nuevo
      // después de los resultados (agregado, nunca editando lo ya enviado)
      conv = { ...conv, customerId: ctx.customerId ?? null, verifiedEmail: ctx.verifiedEmail ?? null };
      const toolMessage: Anthropic.MessageParam = { role: "user", content: results };
      messages.push(toolMessage);
      await this.persist(conv, toolMessage, "tool");
      const next = this.contextMessage(conv, settings, now);
      if (next.content !== context.content) {
        context = next;
        messages.push(next);
        pending.push(next);
      }
    }

    // demasiadas vueltas: algo no está saliendo, mejor un humano
    await withTenant(this.opts.db, conv.tenantId, (tx) =>
      setHandoff(tx, conv.id, "El agente no logró resolver la conversación", this.clock()),
    );
    await this.opts.onHandoff?.(conv, "max_tool_rounds");
    emit({ type: "handoff" });
    const text = byLocale(HANDOFF_FALLBACK, conv.locale ?? settings.defaultLocale);
    await flush();
    await this.persist(conv, { role: "assistant", content: text }, "agent");
    emit({ type: "text", text });
    return [text];
  }

  private recordCall(
    conv: ConversationRow,
    turnId: string,
    model: string,
    r: { durationMs: number; response?: Anthropic.Message; error?: string },
  ): Promise<number> {
    return withTenant(this.opts.db, conv.tenantId, (tx) =>
      recordLlmCall(tx, {
        tenantId: conv.tenantId,
        locationId: conv.locationId,
        conversationId: conv.id,
        channel: conv.channel,
        turnId,
        model,
        ...r,
      }),
    );
  }

  private async runTool(
    conv: ConversationRow,
    ctx: ConversationContext,
    use: Anthropic.ToolUseBlock,
    emit: (event: AgentEvent) => void,
  ): Promise<Anthropic.ToolResultBlockParam> {
    try {
      let result: unknown;
      if (use.name === requestHumanTool.name) {
        const reason = String((use.input as { reason?: string })?.reason ?? "Sin detalle");
        await withTenant(this.opts.db, conv.tenantId, (tx) => setHandoff(tx, conv.id, reason, this.clock()));
        await this.opts.onHandoff?.(conv, reason);
        emit({ type: "handoff" });
        result = { handed_off: true };
      } else {
        result = await handleBookingTool(this.opts.bookings, ctx, use.name, use.input as Record<string, unknown>, {
          emailCodes: this.opts.emailCodes,
        });
      }
      const isError = typeof result === "object" && result !== null && "error" in result;
      return { type: "tool_result", tool_use_id: use.id, content: JSON.stringify(result), is_error: isError };
    } catch (err) {
      // error de infraestructura: el modelo recibe un aviso genérico, el detalle va al log
      (this.opts.log ?? console).error(`[agent] tool ${use.name} falló`, err);
      return {
        type: "tool_result",
        tool_use_id: use.id,
        content: JSON.stringify({ error: "temporary_failure", message: "El sistema de reservas no respondió. Pide disculpas y ofrece intentarlo de nuevo o hablar con una persona." }),
        is_error: true,
      };
    }
  }

  private persist(conv: ConversationRow, message: HistoryMessage, author: "agent" | "tool" | "system") {
    return withTenant(this.opts.db, conv.tenantId, (tx) => appendMessage(tx, conv, message, author));
  }

  /**
   * Bloque fijo por negocio y canal (cacheable) + bloque variable con la fecha y el cliente.
   */
  systemPrompt(conv: ConversationRow, s: AgentSettings): Anthropic.TextBlockParam[] {
    const web = conv.channel === "web";
    const fixed = `Eres el asistente ${web ? "del chat web" : "de WhatsApp"} de ${s.tenantName} (${s.locationName}). Atiendes a los clientes de este negocio: reservas, cambios, cancelaciones y preguntas sobre el negocio.

Cómo escribir:
- Responde en el idioma en que te escribe el cliente (español o inglés), aunque no coincida con el idioma de la página.
- ${TONES[s.tone] ?? TONES.warm}
- ${web ? "Mensajes cortos, como en un chat. Texto simple: sin encabezados, tablas ni Markdown." : "Mensajes cortos, como en un chat. Sin encabezados ni tablas; puedes usar *negrita* de WhatsApp con moderación."}
- No anuncies los pasos que vas a dar ni expliques cómo trabajas (por ejemplo, "voy a revisar la disponibilidad"): usa las herramientas y responde con el resultado.
- Nunca muestres identificadores internos (booking_id, service_id).
- Las horas, en el formato habitual del idioma del cliente (en inglés, 9:00 PM).
${regionRules(s)}

Reservas:
- Ofrece solo horarios que devolvió check_availability. Nunca inventes horarios, precios, menús ni políticas.
- Antes de consultar disponibilidad necesitas servicio, fecha y cantidad de personas. Si falta algo, pregúntalo.${web ? `
- Para apartar a nombre del cliente necesitas su nombre, su teléfono y su email. Pídelos cuando vaya a reservar (no antes) y guárdalos con save_customer_contact apenas te los dé. Si hold_slot devuelve customer_contact_required, pide lo que indica "missing".${this.opts.emailCodes ? `
- list_my_bookings solo muestra las reservas hechas en esta conversación. Si el cliente quiere ver, mover o cancelar otra reserva, pídele su email y usa request_email_code; cuando te diga el código que recibió, usa verify_email_code. Para reservar no hace falta código. No inventes ni repitas códigos: solo pasa el que escribió el cliente.` : ""}` : ""}
- Cuando el cliente elige un horario, llama a hold_slot de inmediato y después muestra un resumen (servicio, fecha, hora, personas, nombre) y pide confirmación.
- Llama a confirm_booking solo después de un "sí" explícito al resumen.
- Si un tool devuelve un motivo o alternativas, explícaselo al cliente con naturalidad y ofrece las alternativas.
- Para cambios de horario, usa reschedule_booking; para cancelar, cancel_booking, siempre después de confirmar con el cliente cuál reserva.

Lo que afirmas:
- Solo di que apartaste, confirmaste, moviste o cancelaste una reserva si el resultado de la herramienta correspondiente lo muestra (held, confirmed, rescheduled o cancelled en true). Si no la llamaste, falló o devolvió otro resultado, no lo afirmes: explica lo que pasó y qué se puede hacer.
- Lo mismo con los datos del cliente: no digas que los guardaste si save_customer_contact no lo confirma.
- Los mensajes que empiezan con "[Persona del equipo]" los escribió alguien del negocio mientras atendía la conversación, no tú. No repitas esa marca. Lo que el equipo dijo o prometió no cuenta como algo que hiciste tú: si hace falta un cambio en una reserva, hazlo con las herramientas.

Límites:
- Temas ajenos al negocio: decláralo con amabilidad y vuelve a lo que puedes ayudar.
- Si el cliente pide una persona, está molesto o necesita algo que no puedes resolver, usa request_human.${handoffRules(s)}

Información del negocio (${s.vertical}):
${s.instructions?.trim() || "Sin información adicional. Si te preguntan algo que no sabes, ofrece pasar con una persona."}${
      s.instructionsEn?.trim()
        ? `

Información del negocio en inglés (úsala tal cual con clientes que escriben en inglés):
${s.instructionsEn.trim()}`
        : ""
    }
- Los servicios pueden traer name_en y description_en: con clientes en inglés usa esos textos; si faltan, traduce.`;

    // fijo durante toda la conversación: lo que cambia va en contextMessage()
    return [{ type: "text", text: fixed, cache_control: { type: "ephemeral" } }];
  }

  /**
   * Lo que cambia entre turnos (fecha y hora, idioma, si el cliente ya dejó sus datos),
   * como mensaje de sistema dentro de la conversación. Va en español como el resto de
   * las instrucciones: es para el modelo, no para el cliente.
   */
  contextMessage(conv: ConversationRow, s: AgentSettings, now: Date): SystemMessage {
    const locale = conv.locale ?? s.defaultLocale;
    return {
      role: "system",
      content: [
        dateContextLine(s.timezone, now),
        `Si no está claro en qué idioma escribe el cliente, usa ${locale === "en" ? "inglés" : "español"}.`,
        this.customerLine(conv),
      ].join("\n"),
    };
  }

  private customerLine(conv: ConversationRow): string {
    if (conv.channel === "web") {
      const contact = conv.customerId
        ? "El cliente ya dejó sus datos de contacto en esta conversación."
        : "Aún no tienes los datos de contacto del cliente.";
      return conv.verifiedEmail
        ? `${contact} Verificó su email (${conv.verifiedEmail}): puedes gestionar todas sus reservas con ese email.`
        : contact;
    }
    return conv.customerProfileName
      ? `El nombre de perfil de WhatsApp del cliente es "${conv.customerProfileName}"; confírmalo antes de usarlo para una reserva.`
      : "No conoces el nombre del cliente; pídelo antes de apartar una reserva.";
  }
}

function textOf(response: Anthropic.Message): string[] {
  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text.trim())
    .filter(Boolean)
    .join("\n\n");
  return text ? [text] : [];
}

/** Estilo según el tono que eligió el negocio. */
const TONES: Record<string, string> = {
  warm: "Tono cálido y cercano.",
  professional: "Tono profesional y cortés, sin ser frío.",
  brief: "Respuestas muy breves y directas: lo justo para avanzar.",
};

/** País y moneda del negocio: se fijan en el alta, así que no cambian dentro de una conversación. */
function regionRules(s: AgentSettings): string {
  const prices = `- Los precios, tal como los entrega list_services (campo price, en ${s.currency === "CLP" ? "pesos chilenos" : "dólares"}). No los conviertas a otra moneda.`;
  return s.country === "CL"
    ? `- El negocio está en Chile. En español, usa el de Chile: "pedir hora", "te la aparté", "¿la confirmo?"; en español, las horas en formato de 24 horas (16:30).\n${prices}`
    : `- El negocio está en Estados Unidos.\n${prices}`;
}

/** "Cuándo pasar con una persona", según lo que escribió el negocio (en sus dos idiomas). */
function handoffRules(s: AgentSettings): string {
  const es = s.handoff?.trim();
  const en = s.handoffEn?.trim();
  if (!es && !en) return "";
  return `
- Además, el negocio pide pasar con una persona (request_human) en estos casos:${es ? `\n${es}` : ""}${en ? `\n${en}` : ""}`;
}

function describeError(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

function byLocale(texts: { es: string; en: string }, locale: string): string {
  return locale.startsWith("en") ? texts.en : texts.es;
}

/** Lo que recibe el cliente si el modelo o la API fallan. La conversación sigue con el agente. */
export function errorReplyText(locale: string): string {
  return byLocale(ERROR_REPLY, locale);
}
