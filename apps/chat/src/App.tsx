import type { ChatTexture } from "@hablahora/contracts";
import { Button, cn, BrandMark, BrandWordmark } from "@hablahora/ui";
import { Composer } from "./components/Composer.js";
import { Header } from "./components/Header.js";
import { MessageList } from "./components/MessageList.js";
import { MESSAGES, type Messages } from "./i18n.js";
import { useChat, type Notice } from "./useChat.js";

/** Incrustado en el sitio del negocio (embed.js): sin bordes y con botón para cerrar. */
const closeEmbed = () => window.parent?.postMessage({ type: "hablahora-chat:close" }, "*");

export function App({ slug, embedded = false }: { slug: string; embedded?: boolean }) {
  const chat = useChat(slug);
  const t = MESSAGES[chat.locale];
  const Shell = embedded ? EmbeddedShell : PageShell;

  if (chat.state.phase === "loading") {
    return (
      <Shell>
        <div className="grid flex-1 place-items-center" role="status" aria-label="…">
          <BrandMark className="h-8 w-8 text-line motion-safe:animate-pulse" />
        </div>
      </Shell>
    );
  }
  if (chat.state.phase === "unavailable") {
    return (
      <Shell>
        <div className="flex flex-1 flex-col items-start justify-center gap-3 px-6">
          <h1 className="text-2xl font-display font-bold text-balance">{t.unavailableTitle}</h1>
          <p className="text-muted">{t.unavailable}</p>
          {embedded ? (
            <Button variant="outline" onClick={closeEmbed}>
              {t.close}
            </Button>
          ) : null}
        </div>
      </Shell>
    );
  }
  if (chat.state.phase === "not_found" || chat.state.phase === "load_error") {
    const notFound = chat.state.phase === "not_found";
    return (
      <Shell>
        <div className="flex flex-1 flex-col items-start justify-center gap-3 px-6">
          <BrandMark className="h-7 w-7 text-brand" />
          <h1 className="text-2xl font-display font-bold">{notFound ? t.notFoundTitle : t.loadError}</h1>
          {notFound ? <p className="text-muted">{t.notFound}</p> : null}
          {!notFound ? (
            <Button variant="brand" onClick={() => void chat.retry()}>
              {t.retry}
            </Button>
          ) : null}
        </div>
      </Shell>
    );
  }

  const { info } = chat.state;
  const welcome = info.welcome[chat.locale] ?? t.welcome(info.name);
  return (
    <Shell tint={info.tint} texture={info.texture}>
      <Header
        name={info.name}
        logoUrl={info.logoUrl}
        locale={chat.locale}
        t={t}
        onLocale={chat.setLocale}
        onNewChat={chat.newConversation}
        canStartNew={!chat.busy && chat.messages.length > 0}
        onClose={embedded ? closeEmbed : undefined}
      />
      <MessageList welcome={welcome} messages={chat.messages} working={chat.working} t={t} />
      {chat.handoff ? <Banner tone="info">{t.handoff}</Banner> : null}
      {chat.notice ? <NoticeBanner notice={chat.notice} t={t} onNewChat={chat.newConversation} /> : null}
      <Composer t={t} busy={chat.busy} onSend={chat.send} />
      <p className="flex items-center justify-center gap-1.5 bg-surface pb-[max(0.5rem,env(safe-area-inset-bottom))] text-[0.7rem] text-muted">
        {t.poweredBy} <BrandWordmark mono className="text-[0.8rem]" />
        {info.privacy ? (
          <>
            <span aria-hidden="true">·</span>
            {/* en una pestaña nueva: el chat puede estar incrustado en el sitio del negocio */}
            <a href={`/privacidad?lang=${chat.locale}`} target="_blank" rel="noopener" className="underline-offset-2 hover:underline">
              {t.privacy}
            </a>
          </>
        ) : null}
      </p>
    </Shell>
  );
}

/** El fondo del negocio se conoce al cargar su información; antes, el fondo neutro. */
type ShellProps = { children: React.ReactNode; tint?: boolean; texture?: ChatTexture };

/** Columna del chat: pantalla completa en el teléfono, centrada en la computadora. */
function PageShell({ children, tint, texture }: ShellProps) {
  return (
    <main
      data-tint={tint}
      data-texture={texture}
      className="chat-backdrop mx-auto flex h-dvh w-full max-w-2xl flex-col text-ink sm:border-x sm:border-line"
    >
      {children}
    </main>
  );
}

/** Dentro del panel de embed.js: ocupa todo el panel, sin bordes propios. */
function EmbeddedShell({ children, tint, texture }: ShellProps) {
  return (
    <main data-tint={tint} data-texture={texture} className="chat-backdrop flex h-dvh w-full flex-col text-ink">
      {children}
    </main>
  );
}

function Banner({ tone, children, action }: { tone: "info" | "warning" | "danger"; children: string; action?: React.ReactNode }) {
  return (
    <div
      role="status"
      className={cn(
        "mx-3 mb-2 flex items-center gap-3 rounded-lg px-3.5 py-2.5 text-sm",
        tone === "info" && "bg-info-bg text-info",
        tone === "warning" && "bg-warning-bg text-warning",
        tone === "danger" && "bg-danger-bg text-danger",
      )}
    >
      <span className="flex-1">{children}</span>
      {action}
    </div>
  );
}

function NoticeBanner({ notice, t, onNewChat }: { notice: NonNullable<Notice>; t: Messages; onNewChat: () => void }) {
  if (notice === "session_limit") {
    return (
      <Banner
        tone="warning"
        action={
          <Button size="sm" variant="outline" onClick={onNewChat}>
            {t.newChat}
          </Button>
        }
      >
        {t.sessionLimit}
      </Banner>
    );
  }
  return <Banner tone={notice === "rate_limited" ? "warning" : "danger"}>{notice === "rate_limited" ? t.rateLimited : t.sendError}</Banner>;
}
