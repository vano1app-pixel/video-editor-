"use client";

import { useEffect, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";
import clsx from "clsx";

import QuestionCard from "./QuestionCard";
import type { ChatMessage, ClarifyingQuestion, PlannerTurn } from "@/lib/types";

const SUGGESTIONS = [
  "Make a punchy 20 second clip of the best bits",
  "Cut the long pauses but keep it natural",
  "Vertical clip for TikTok with big captions",
];

export interface ChatPanelProps {
  messages: ChatMessage[];
  turn: PlannerTurn | null;
  /** A request is in flight (including 409 retry waits). */
  busy: boolean;
  /** Assistant-side status line, e.g. "EditAi is still watching your video…". */
  statusLine: string | null;
  /** Set when the server returned 503 (no AI key configured). */
  configError: string | null;
  /** Any other request failure. */
  errorMessage: string | null;
  /** Question ids that have already been answered. */
  answeredIds: string[];
  composerRef: RefObject<HTMLTextAreaElement | null>;
  /** PlanCard, rendered above the composer once the plan is ready. */
  planSlot: ReactNode;
  onSend: (text: string) => void;
  onAnswer: (question: ClarifyingQuestion, value: string) => void;
  onRetry: () => void;
}

function SparkleIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className="h-4 w-4">
      <path d="M11 2.2 12.9 8 18.7 9.9 12.9 11.8 11 17.6 9.1 11.8 3.3 9.9 9.1 8 11 2.2Z" />
      <path d="M18.4 14.2 19.4 17.1 22.3 18.1 19.4 19.1 18.4 22 17.4 19.1 14.5 18.1 17.4 17.1 18.4 14.2Z" />
    </svg>
  );
}

function SendIcon(): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="h-5 w-5"
    >
      <path d="M5 12h13" />
      <path d="m12 5 7 7-7 7" />
    </svg>
  );
}

function Avatar(): React.JSX.Element {
  return (
    <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent/20 text-accent">
      <SparkleIcon />
    </div>
  );
}

export default function ChatPanel({
  messages,
  turn,
  busy,
  statusLine,
  configError,
  errorMessage,
  answeredIds,
  composerRef,
  planSlot,
  onSend,
  onAnswer,
  onRetry,
}: ChatPanelProps): React.JSX.Element {
  const [draft, setDraft] = useState("");
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    list.scrollTop = list.scrollHeight;
  }, [messages.length, busy, statusLine, turn]);

  function submit(): void {
    const text = draft.trim();
    if (text === "" || busy) return;
    setDraft("");
    onSend(text);
  }

  let lastAssistantIndex = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === "assistant") {
      lastAssistantIndex = i;
      break;
    }
  }

  const questions: ClarifyingQuestion[] = turn?.questions ?? [];

  return (
    <section
      aria-label="Chat with EditAi"
      className="flex h-[min(70vh,660px)] min-h-[440px] flex-col overflow-hidden rounded-2xl border border-line bg-panel"
    >
      <div
        ref={listRef}
        className="scrollbar-thin flex-1 space-y-4 overflow-y-auto p-4 sm:p-5"
      >
        {messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-4 px-2 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent/15 text-accent">
              <SparkleIcon />
            </div>
            <p className="text-lg font-semibold">What should EditAi make?</p>
            <p className="max-w-sm text-sm text-muted">
              Describe it the way you&apos;d tell a friend. No editing words needed.
            </p>
            <div className="flex flex-wrap justify-center gap-2">
              {SUGGESTIONS.map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  disabled={busy}
                  onClick={() => onSend(suggestion)}
                  className="min-h-[44px] rounded-full border border-line bg-white/[0.04] px-4 text-sm text-fg/85 transition-colors duration-200 hover:bg-white/[0.09] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-panel disabled:opacity-50"
                >
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {messages.map((message, index) => (
          <div key={message.id}>
            <div
              className={clsx(
                "flex gap-2",
                message.role === "user" ? "justify-end" : "justify-start",
              )}
            >
              {message.role === "assistant" ? <Avatar /> : null}
              <div
                className={clsx(
                  "max-w-[86%] whitespace-pre-wrap break-words rounded-2xl px-4 py-3 text-sm leading-relaxed",
                  message.role === "user"
                    ? "border border-accent/30 bg-accent/20 text-fg"
                    : "border border-line bg-panel-2 text-fg",
                )}
              >
                {message.content}
              </div>
            </div>

            {message.role === "assistant" &&
            index === lastAssistantIndex &&
            questions.length > 0 ? (
              <div className="mt-3 space-y-3 pl-0 sm:pl-9">
                {questions.map((question) => (
                  <QuestionCard
                    key={question.id}
                    question={question}
                    answered={answeredIds.includes(question.id)}
                    disabled={busy}
                    onAnswer={onAnswer}
                  />
                ))}
              </div>
            ) : null}
          </div>
        ))}

        {busy ? (
          <div className="flex justify-start gap-2">
            <Avatar />
            <div className="rounded-2xl border border-line bg-panel-2 px-4 py-3">
              <span className="flex items-center gap-1.5" aria-label="EditAi is typing">
                <span className="typing-dot h-2 w-2 rounded-full bg-muted" />
                <span className="typing-dot h-2 w-2 rounded-full bg-muted" />
                <span className="typing-dot h-2 w-2 rounded-full bg-muted" />
              </span>
            </div>
          </div>
        ) : null}

        {statusLine !== null ? (
          <p className="pl-0 text-xs text-muted sm:pl-9" role="status">
            {statusLine}
          </p>
        ) : null}

        {configError !== null ? (
          <div className="rounded-2xl border border-danger/30 bg-danger/[0.08] p-4">
            <p className="text-sm font-semibold text-fg">
              EditAi isn&apos;t configured with an AI key yet.
            </p>
            <p className="mt-1 text-sm text-muted">
              Add ANTHROPIC_API_KEY to .env and restart.
            </p>
          </div>
        ) : null}

        {errorMessage !== null ? (
          <div className="rounded-2xl border border-danger/30 bg-danger/[0.08] p-4">
            <p className="text-sm text-fg">{errorMessage}</p>
            <button
              type="button"
              onClick={onRetry}
              disabled={busy}
              className="mt-3 min-h-[44px] rounded-full bg-accent px-5 text-sm font-semibold text-white transition-colors duration-200 hover:bg-accent-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-panel disabled:opacity-50"
            >
              Try again
            </button>
          </div>
        ) : null}
      </div>

      {planSlot ? (
        <div className="border-t border-line p-4 sm:p-5">{planSlot}</div>
      ) : null}

      <div className="border-t border-line p-3 sm:p-4">
        <div className="flex items-end gap-2">
          <textarea
            ref={composerRef}
            rows={2}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (
                event.key === "Enter" &&
                !event.shiftKey &&
                !event.nativeEvent.isComposing
              ) {
                event.preventDefault();
                submit();
              }
            }}
            placeholder="e.g. Make a punchy 20 second clip of the best bits, add captions"
            aria-label="Describe your edit"
            className="max-h-40 min-h-[52px] w-full min-w-0 resize-none rounded-2xl border border-line bg-white/[0.04] px-4 py-3 text-sm leading-relaxed text-fg placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          />
          <button
            type="button"
            onClick={submit}
            disabled={busy || draft.trim() === ""}
            aria-label="Send message"
            className="flex h-[52px] w-[52px] shrink-0 items-center justify-center rounded-2xl bg-accent text-white transition-colors duration-200 hover:bg-accent-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-panel disabled:cursor-not-allowed disabled:opacity-40"
          >
            <SendIcon />
          </button>
        </div>
      </div>
    </section>
  );
}
