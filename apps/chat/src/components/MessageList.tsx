import { cn } from "@hablahora/ui";
import { useEffect, useRef } from "react";
import type { Messages } from "../i18n.js";
import type { ChatMessage } from "../useChat.js";

export function MessageList(props: {
  welcome: string;
  messages: ChatMessage[];
  working: string | null;
  t: Messages;
}) {
  const { messages, working, t } = props;
  const end = useRef<HTMLDivElement>(null);
  const last = messages.at(-1);

  // seguir el texto a medida que llega
  useEffect(() => {
    end.current?.scrollIntoView?.({ block: "end", behavior: "smooth" });
  }, [messages.length, last?.text, working]);

  const label = working ? (working === "thinking" ? t.thinking : (t.tools[working] ?? t.thinking)) : null;

  return (
    <div
      role="log"
      aria-live="polite"
      aria-busy={working !== null}
      className="flex flex-1 flex-col gap-2 overflow-y-auto px-4 py-4"
    >
      <Bubble role="agent" t={t}>
        {props.welcome}
      </Bubble>
      {messages.map((m) => (
        <Bubble key={m.id} role={m.role} failed={m.failed} t={t}>
          {m.text}
        </Bubble>
      ))}
      {label ? (
        <div className="flex items-center gap-2 px-1 py-0.5 text-xs text-muted" role="status">
          <span aria-hidden="true" className="flex gap-[3px]">
            {[0, 150, 300].map((delay) => (
              <i
                key={delay}
                className="h-[5px] w-[5px] rounded-full bg-muted motion-safe:animate-pulse"
                style={{ animationDelay: `${delay}ms` }}
              />
            ))}
          </span>
          {label}
        </div>
      ) : null}
      <div ref={end} />
    </div>
  );
}

function Bubble(props: { role: ChatMessage["role"]; failed?: boolean; t: Messages; children: string }) {
  const mine = props.role === "customer";
  return (
    <div className={cn("flex max-w-[85%] flex-col gap-0.5", mine ? "items-end self-end" : "items-start self-start")}>
      <span className="sr-only">{mine ? props.t.you : props.role === "staff" ? props.t.team : props.t.assistant}:</span>
      {props.role === "staff" ? <span className="px-1 text-[0.7rem] font-semibold text-info">{props.t.team}</span> : null}
      <p
        className={cn(
          "rounded-2xl px-3.5 py-2.5 text-[0.9375rem] leading-normal break-words whitespace-pre-wrap",
          mine ? "rounded-br-md bg-accent text-white" : "rounded-bl-md border border-line bg-raised",
          props.failed && "opacity-60",
        )}
      >
        {props.children}
      </p>
      {props.failed ? <span className="px-1 text-[0.7rem] text-danger">{props.t.notSent}</span> : null}
    </div>
  );
}
