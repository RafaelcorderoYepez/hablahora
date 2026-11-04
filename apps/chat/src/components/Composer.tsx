import { MAX_CHAT_MESSAGE_CHARS } from "@hablahora/contracts/browser";
import { Button } from "@hablahora/ui";
import { ArrowUp } from "lucide-react";
import { useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import type { Messages } from "../i18n.js";

export function Composer(props: { t: Messages; busy: boolean; onSend: (text: string) => Promise<boolean> }) {
  const { t } = props;
  const [text, setText] = useState("");
  const area = useRef<HTMLTextAreaElement>(null);
  const empty = !text.trim();
  const near = text.length > MAX_CHAT_MESSAGE_CHARS - 200;

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (empty || props.busy) return;
    const value = text;
    setText("");
    resize();
    const ok = await props.onSend(value);
    if (!ok) setText((current) => current || value); // si no se envió, el texto vuelve al cuadro
    area.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter envía; Shift+Enter hace un salto de línea; no cortar a quien escribe con IME
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit();
    }
  };

  const resize = () => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  };

  return (
    <form
      onSubmit={submit}
      className="flex items-end gap-2 border-t border-line bg-surface px-3 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <label htmlFor="chat-message" className="sr-only">
          {t.placeholder}
        </label>
        <textarea
          id="chat-message"
          ref={area}
          rows={1}
          value={text}
          maxLength={MAX_CHAT_MESSAGE_CHARS}
          placeholder={t.placeholder}
          onChange={(e) => {
            setText(e.target.value);
            resize();
          }}
          onKeyDown={onKeyDown}
          className="max-h-[140px] resize-none rounded-[1.25rem] border border-line bg-bg px-4 py-2.5 text-[0.9375rem] text-ink placeholder:text-muted focus-visible:outline-2 focus-visible:outline-accent"
        />
        {near ? (
          <span className="px-2 text-[0.7rem] text-muted tabular-nums">
            {text.length} / {MAX_CHAT_MESSAGE_CHARS} · {t.tooLong(MAX_CHAT_MESSAGE_CHARS)}
          </span>
        ) : null}
      </div>
      <Button type="submit" size="icon" disabled={empty || props.busy} aria-label={t.send} className="rounded-full">
        <ArrowUp className="h-5 w-5" aria-hidden="true" />
      </Button>
    </form>
  );
}
