"use client";

import { useState } from "react";
import clsx from "clsx";

import type { ClarifyingQuestion } from "@/lib/types";

export interface QuestionCardProps {
  question: ClarifyingQuestion;
  /** True once this question has been answered — the card locks. */
  answered: boolean;
  /** True while a request is in flight. */
  disabled: boolean;
  /** Value is the chosen label, or multiple labels joined by ", ". */
  onAnswer: (question: ClarifyingQuestion, value: string) => void;
}

function CheckIcon(): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="h-3.5 w-3.5"
    >
      <path d="m5 13 4 4L19 7" />
    </svg>
  );
}

function chipClasses(selected: boolean): string {
  return clsx(
    "min-h-[44px] rounded-full px-4 text-sm font-medium transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-panel-2 disabled:cursor-not-allowed disabled:opacity-50",
    selected
      ? "bg-accent text-white"
      : "border border-line bg-white/[0.04] text-fg/85 hover:bg-white/[0.09]",
  );
}

export default function QuestionCard({
  question,
  answered,
  disabled,
  onAnswer,
}: QuestionCardProps): React.JSX.Element {
  const [picked, setPicked] = useState<string[]>([]);
  const [freeText, setFreeText] = useState("");
  const [chosen, setChosen] = useState<string | null>(null);

  // A "single"/"multi" question with no options can only be answered as text.
  const kind =
    question.options.length === 0 || question.kind === "text"
      ? "text"
      : question.kind;

  const locked = answered || chosen !== null;

  function submit(value: string): void {
    const clean = value.trim();
    if (clean === "" || locked || disabled) return;
    setChosen(clean);
    onAnswer(question, clean);
  }

  function toggle(option: string): void {
    setPicked((prev) =>
      prev.includes(option)
        ? prev.filter((item) => item !== option)
        : [...prev, option],
    );
  }

  return (
    <div
      className={clsx(
        "rounded-2xl border border-line bg-panel-2 p-4 transition-colors duration-200",
        locked && "opacity-60",
      )}
    >
      <p className="text-sm font-semibold text-fg">{question.question}</p>
      {question.rationale ? (
        <p className="mt-1 text-xs text-muted">{question.rationale}</p>
      ) : null}

      {locked ? (
        <p className="mt-3 inline-flex items-center gap-2 rounded-full bg-accent/15 px-3 py-2 text-sm text-fg">
          <CheckIcon />
          <span className="break-words">{chosen ?? "Answered"}</span>
        </p>
      ) : kind === "single" ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {question.options.map((option, index) => (
            <button
              key={`${question.id}-${index}-${option}`}
              type="button"
              disabled={disabled}
              onClick={() => submit(option)}
              className={chipClasses(false)}
            >
              {option}
            </button>
          ))}
        </div>
      ) : kind === "multi" ? (
        <>
          <div className="mt-3 flex flex-wrap gap-2">
            {question.options.map((option, index) => (
              <button
                key={`${question.id}-${index}-${option}`}
                type="button"
                disabled={disabled}
                aria-pressed={picked.includes(option)}
                onClick={() => toggle(option)}
                className={chipClasses(picked.includes(option))}
              >
                {option}
              </button>
            ))}
          </div>
          <button
            type="button"
            disabled={disabled || picked.length === 0}
            onClick={() => submit(picked.join(", "))}
            className="mt-3 min-h-[44px] rounded-full bg-accent px-5 text-sm font-semibold text-white transition-colors duration-200 hover:bg-accent-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-panel-2 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Done
          </button>
        </>
      ) : (
        <form
          className="mt-3 flex flex-col gap-2 sm:flex-row"
          onSubmit={(event) => {
            event.preventDefault();
            submit(freeText);
          }}
        >
          <input
            type="text"
            value={freeText}
            disabled={disabled}
            onChange={(event) => setFreeText(event.target.value)}
            placeholder="Type your answer"
            aria-label={question.question}
            className="min-h-[44px] w-full min-w-0 rounded-full border border-line bg-white/[0.04] px-4 text-sm text-fg placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          />
          <button
            type="submit"
            disabled={disabled || freeText.trim() === ""}
            className="min-h-[44px] shrink-0 rounded-full bg-accent px-5 text-sm font-semibold text-white transition-colors duration-200 hover:bg-accent-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-panel-2 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Send
          </button>
        </form>
      )}
    </div>
  );
}
