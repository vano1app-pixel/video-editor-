"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import clsx from "clsx";

import BriefBar from "./components/BriefBar";
import ChatPanel from "./components/ChatPanel";
import DrivePicker from "./components/DrivePicker";
import PlanCard from "./components/PlanCard";
import ProgressBar from "./components/ProgressBar";
import ResultPlayer from "./components/ResultPlayer";
import UploadZone from "./components/UploadZone";
import type { UploadZoneStatus } from "./components/UploadZone";

import { JOB_STAGE_LABELS, emptyBrief } from "@/lib/types";
import type {
  Answer,
  ApiError,
  Brief,
  ChatMessage,
  ChatRequest,
  ChatResponse,
  ChatRole,
  ClarifyingQuestion,
  CreateJobRequest,
  CreateJobResponse,
  Job,
  JobProgress,
  JobStage,
  PlannerTurn,
  Source,
  UploadResponse,
} from "@/lib/types";

/** Explicit signature so the recursive 409 retry doesn't defeat inference. */
type SendChat = (
  nextMessages: ChatMessage[],
  nextBrief: Brief,
  attempt?: number,
) => Promise<void>;

type Phase =
  | "idle"
  | "uploading"
  | "briefing"
  | "planned"
  | "rendering"
  | "done"
  | "error";

const PREP_POLL_MS = 1500;
const JOB_POLL_MS = 1200;
const CHAT_RETRY_MS = 3000;
const MAX_CHAT_RETRIES = 20;

const INITIAL_PREP: JobProgress = {
  stage: "queued",
  overall: 0,
  stageProgress: 0,
  message: "Getting your video ready…",
};

const FLAVOUR_LINES = [
  "Watching your footage…",
  "Cutting the boring bits…",
  "Tightening the pauses…",
  "Burning in captions…",
  "Polishing the audio…",
];

let messageSeq = 0;

function makeMessage(role: ChatRole, content: string): ChatMessage {
  messageSeq += 1;
  return {
    id: `m${messageSeq}`,
    role,
    content,
    createdAt: Date.now(),
  };
}

function isTerminalStage(stage: JobStage): boolean {
  return stage === "done" || stage === "failed" || stage === "cancelled";
}

/** Turn the ?reason= code from the Drive OAuth callback into plain English. */
function driveErrorMessage(reason: string | null): string {
  switch (reason) {
    case "denied":
      return "Google Drive access was declined. Nothing was connected.";
    case "state":
      return "That sign-in link expired. Please try connecting Drive again.";
    case "no_code":
      return "Google didn't send back a sign-in code. Please try again.";
    case "exchange":
      return "EditAi couldn't finish signing in to Google Drive. Please try again.";
    default:
      return "Connecting Google Drive didn't work. Please try again.";
  }
}

function apiErrorFromText(text: string): string | null {
  try {
    const body = JSON.parse(text) as Partial<ApiError>;
    if (typeof body.error === "string" && body.error.trim() !== "") {
      return body.error;
    }
  } catch {
    // Not JSON — the caller falls back to a generic message.
  }
  return null;
}

async function apiErrorFromResponse(
  res: Response,
  fallback: string,
): Promise<string> {
  try {
    const body = (await res.json()) as Partial<ApiError>;
    if (typeof body.error === "string" && body.error.trim() !== "") {
      // Surface `detail` too. Without it the user sees "the planner couldn't
      // answer that" with no way to tell a bad key from a bad request, and the
      // only copy of the real reason is in the server log they can't see.
      const detail =
        typeof body.detail === "string" ? body.detail.trim() : "";
      return detail && detail !== body.error
        ? `${body.error} (${trimDetail(detail)})`
        : body.error;
    }
  } catch {
    // Non-JSON error body.
  }
  return fallback;
}

/** Keep an error readable in a card: drop the noisy prefix, cap the length. */
function trimDetail(detail: string): string {
  const cleaned = detail.replace(/^Error:\s*/i, "").trim();
  return cleaned.length > 300 ? `${cleaned.slice(0, 300)}…` : cleaned;
}

function SparkleIcon({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      className={className ?? "h-4 w-4"}
    >
      <path d="M11 2.2 12.9 8 18.7 9.9 12.9 11.8 11 17.6 9.1 11.8 3.3 9.9 9.1 8 11 2.2Z" />
      <path d="M18.4 14.2 19.4 17.1 22.3 18.1 19.4 19.1 18.4 22 17.4 19.1 14.5 18.1 17.4 17.1 18.4 14.2Z" />
    </svg>
  );
}

function PrepStrip({
  prep,
  ready,
  error,
  compact,
}: {
  prep: JobProgress;
  ready: boolean;
  error: string | null;
  compact?: boolean;
}): React.JSX.Element {
  const message = error ?? (ready ? "Ready" : prep.message || JOB_STAGE_LABELS[prep.stage]);

  return (
    <div className={clsx(compact ? "" : "mt-4")}>
      <div className="flex items-center justify-between gap-2">
        <p
          className={clsx(
            "min-w-0 flex-1 truncate text-xs",
            error !== null ? "text-danger" : "text-muted",
          )}
        >
          {message}
        </p>
        {ready && error === null ? (
          <span className="shrink-0 rounded-full bg-success/15 px-2.5 py-1 text-[11px] font-semibold text-success">
            Ready
          </span>
        ) : null}
      </div>
      {!ready && error === null ? (
        <ProgressBar
          value={prep.overall}
          label="Preparing your video"
          className="mt-2"
        />
      ) : null}
    </div>
  );
}

function RenderingCard({
  job,
  cancelling,
  onCancel,
}: {
  job: Job;
  cancelling: boolean;
  onCancel: () => void;
}): React.JSX.Element {
  const [flavourIndex, setFlavourIndex] = useState(0);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setFlavourIndex((index) => (index + 1) % FLAVOUR_LINES.length);
    }, 3000);
    return () => window.clearInterval(timer);
  }, []);

  const fraction = Math.min(1, Math.max(0, job.progress.overall));
  const pct = Math.round(fraction * 100);

  return (
    <div className="mx-auto w-full max-w-xl rounded-2xl border border-line bg-panel p-6 text-center sm:p-10">
      <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-accent/15 text-accent">
        <SparkleIcon className="h-7 w-7" />
      </div>
      <h2 className="mt-5 text-2xl font-semibold sm:text-3xl">
        EditAi is editing your video
      </h2>
      <p className="mt-6 text-4xl font-semibold tabular-nums">{pct}%</p>
      <ProgressBar
        value={fraction}
        size="md"
        label="Render progress"
        className="mt-4"
      />
      <p className="mt-4 text-sm font-medium text-fg">
        {job.progress.message || JOB_STAGE_LABELS[job.progress.stage]}
      </p>
      <p className="mt-1 text-sm text-muted" aria-live="polite">
        {FLAVOUR_LINES[flavourIndex]}
      </p>
      <button
        type="button"
        onClick={onCancel}
        disabled={cancelling}
        className="mt-8 min-h-[44px] rounded-full px-5 text-sm text-muted transition-colors duration-200 hover:bg-white/[0.06] hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-panel disabled:opacity-50"
      >
        {cancelling ? "Cancelling…" : "Cancel"}
      </button>
    </div>
  );
}

export default function Home(): React.JSX.Element {
  const [phase, setPhase] = useState<Phase>("idle");
  const [source, setSource] = useState<Source | null>(null);

  // Upload
  const [uploadName, setUploadName] = useState<string | null>(null);
  const [uploadLoaded, setUploadLoaded] = useState(0);
  const [uploadTotal, setUploadTotal] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);

  // Prep
  const [prep, setPrep] = useState<JobProgress>(INITIAL_PREP);
  const [prepError, setPrepError] = useState<string | null>(null);
  const [analysisReady, setAnalysisReady] = useState(false);

  const [driveOpen, setDriveOpen] = useState(false);
  const [driveNotice, setDriveNotice] = useState<string | null>(null);

  /**
   * The single entry point into briefing. Both a dropped file and a Drive
   * import land here, so prep polling and the chat start identically however
   * the video arrived.
   */
  const acceptSource = useCallback((incoming: Source) => {
    setSource(incoming);
    setPrep(INITIAL_PREP);
    setPrepError(null);
    setAnalysisReady(false);
    setPhase("briefing");
  }, []);

  /**
   * Handle the OAuth landing. Google sends the browser back to "/?drive=...",
   * so read it once on mount and strip it — otherwise a refresh re-triggers the
   * picker. window.location is used rather than useSearchParams, which would
   * force this whole page behind a Suspense boundary.
   */
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const drive = params.get("drive");
    if (!drive) return;

    if (drive === "connected") {
      setDriveNotice(null);
      setDriveOpen(true);
    } else if (drive === "error") {
      setDriveOpen(false);
      setDriveNotice(driveErrorMessage(params.get("reason")));
    }

    params.delete("drive");
    params.delete("reason");
    const query = params.toString();
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${query ? `?${query}` : ""}`,
    );
  }, []);

  // Briefing
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [brief, setBrief] = useState<Brief>(() => emptyBrief());
  const [turn, setTurn] = useState<PlannerTurn | null>(null);
  const [answeredIds, setAnsweredIds] = useState<string[]>([]);
  const [captionsOn, setCaptionsOn] = useState(true);
  const [musicName, setMusicName] = useState<string | null>(null);
  const [chatBusy, setChatBusy] = useState(false);
  const [chatStatus, setChatStatus] = useState<string | null>(null);
  const [chatConfigError, setChatConfigError] = useState<string | null>(null);
  const [chatErrorMsg, setChatErrorMsg] = useState<string | null>(null);

  // Render job
  const [job, setJob] = useState<Job | null>(null);
  const [startingJob, setStartingJob] = useState(false);
  const [jobStartError, setJobStartError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);

  const pendingFileRef = useRef<File | null>(null);
  const uploadXhrRef = useRef<XMLHttpRequest | null>(null);
  const retryTimerRef = useRef<number | null>(null);
  const captionsSentRef = useRef<boolean | null>(null);
  const lastSendRef = useRef<{ messages: ChatMessage[]; brief: Brief } | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);

  const clearRetryTimer = useCallback(() => {
    if (retryTimerRef.current !== null) {
      window.clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      if (retryTimerRef.current !== null) {
        window.clearTimeout(retryTimerRef.current);
      }
      uploadXhrRef.current?.abort();
    };
  }, []);

  // --- Upload --------------------------------------------------------------

  const startUpload = useCallback((file: File) => {
    pendingFileRef.current = file;
    setUploadError(null);
    setUploadName(file.name);
    setUploadLoaded(0);
    setUploadTotal(file.size);
    setPhase("uploading");

    const xhr = new XMLHttpRequest();
    uploadXhrRef.current = xhr;

    xhr.open(
      "POST",
      `/api/upload?filename=${encodeURIComponent(file.name)}&kind=video`,
    );

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        setUploadLoaded(event.loaded);
        setUploadTotal(event.total);
      }
    };

    xhr.onload = () => {
      uploadXhrRef.current = null;
      if (xhr.status >= 200 && xhr.status < 300) {
        let uploaded: Source | null = null;
        try {
          const body = JSON.parse(xhr.responseText) as Partial<UploadResponse>;
          uploaded = body.source ?? null;
        } catch {
          uploaded = null;
        }
        if (!uploaded) {
          setUploadError("EditAi couldn't read the server's reply. Please try again.");
          setPhase("idle");
          return;
        }
        acceptSource(uploaded);
        return;
      }
      setUploadError(
        apiErrorFromText(xhr.responseText) ??
          `The upload was rejected (error ${xhr.status}). Please try again.`,
      );
      setPhase("idle");
    };

    xhr.onerror = () => {
      uploadXhrRef.current = null;
      setUploadError("Your connection dropped during the upload. Please try again.");
      setPhase("idle");
    };

    xhr.onabort = () => {
      uploadXhrRef.current = null;
    };

    xhr.send(file);
  }, []);

  const retryUpload = useCallback(() => {
    const file = pendingFileRef.current;
    if (!file) {
      setUploadError(null);
      setPhase("idle");
      return;
    }
    startUpload(file);
  }, [startUpload]);

  const dismissUploadError = useCallback(() => {
    pendingFileRef.current = null;
    setUploadError(null);
    setUploadName(null);
    setPhase("idle");
  }, []);

  // --- Prep polling --------------------------------------------------------

  useEffect(() => {
    const sourceId = source?.id;
    if (!sourceId || analysisReady || prepError !== null) return;

    let cancelled = false;
    let timer: number | undefined;

    const tick = async (): Promise<void> => {
      try {
        const res = await fetch(`/api/sources/${sourceId}`, { cache: "no-store" });
        if (res.ok) {
          const data = (await res.json()) as {
            source: Source;
            prep: JobProgress;
            prepError: string | null;
            analysisReady: boolean;
          };
          if (cancelled) return;
          setPrep(data.prep);
          setPrepError(data.prepError);
          setAnalysisReady(data.analysisReady);
          setSource((prev) =>
            prev && prev.id === data.source.id && prev.media === null && data.source.media
              ? data.source
              : prev,
          );
          if (data.analysisReady || data.prepError !== null) return;
        }
      } catch {
        // Transient network blip — keep polling.
      }
      if (!cancelled) {
        timer = window.setTimeout(() => {
          void tick();
        }, PREP_POLL_MS);
      }
    };

    void tick();

    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [source?.id, analysisReady, prepError]);

  // --- Chat ----------------------------------------------------------------

  const sendChat = useCallback<SendChat>(
    async (nextMessages, nextBrief, attempt = 0) => {
      const sourceId = source?.id;
      if (!sourceId) return;

      lastSendRef.current = { messages: nextMessages, brief: nextBrief };
      clearRetryTimer();
      setChatBusy(true);
      setChatConfigError(null);
      setChatErrorMsg(null);
      if (attempt === 0) setChatStatus(null);

      const payload: ChatRequest = {
        sourceId,
        messages: nextMessages,
        brief: nextBrief,
      };

      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });

        if (res.status === 409) {
          if (attempt >= MAX_CHAT_RETRIES) {
            setChatBusy(false);
            setChatStatus(null);
            setChatErrorMsg(
              "EditAi is taking longer than usual to read your video. Your message is saved — tap Try again in a moment.",
            );
            return;
          }
          setChatStatus("EditAi is still watching your video…");
          retryTimerRef.current = window.setTimeout(() => {
            retryTimerRef.current = null;
            void sendChat(nextMessages, nextBrief, attempt + 1);
          }, CHAT_RETRY_MS);
          return;
        }

        if (res.status === 503) {
          setChatBusy(false);
          setChatStatus(null);
          setChatConfigError(
            "EditAi isn't configured with an AI key yet. Add ANTHROPIC_API_KEY to .env and restart.",
          );
          return;
        }

        if (!res.ok) {
          const message = await apiErrorFromResponse(
            res,
            `EditAi couldn't answer that (error ${res.status}).`,
          );
          setChatBusy(false);
          setChatStatus(null);
          setChatErrorMsg(message);
          return;
        }

        const data = (await res.json()) as Partial<ChatResponse>;
        const nextTurn = data.turn;
        if (!nextTurn) {
          setChatBusy(false);
          setChatStatus(null);
          setChatErrorMsg("EditAi sent back an empty reply. Please try again.");
          return;
        }

        setTurn(nextTurn);
        if (nextTurn.reply.trim() !== "") {
          setMessages((prev) => [...prev, makeMessage("assistant", nextTurn.reply)]);
        }
        setPhase(nextTurn.ready && nextTurn.plan ? "planned" : "briefing");
        setChatBusy(false);
        setChatStatus(null);
      } catch {
        setChatBusy(false);
        setChatStatus(null);
        setChatErrorMsg(
          "EditAi couldn't be reached. Check your connection and try again.",
        );
      }
    },
    [source?.id, clearRetryTimer],
  );

  /** Tells the planner about the caption choice, but only when it changed. */
  const captionsSuffix = useCallback((): string => {
    if (captionsSentRef.current === captionsOn) return "";
    captionsSentRef.current = captionsOn;
    return captionsOn
      ? "\n\nCaptions: yes — burn big, readable subtitles into the video."
      : "\n\nCaptions: no — leave the video without subtitles.";
  }, [captionsOn]);

  const handleSend = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (trimmed === "" || !source || chatBusy) return;

      const content = `${trimmed}${captionsSuffix()}`;
      const nextMessages = [...messages, makeMessage("user", content)];
      const nextBrief: Brief = {
        ...brief,
        request: brief.request.trim() === "" ? trimmed : brief.request,
      };

      setMessages(nextMessages);
      setBrief(nextBrief);
      void sendChat(nextMessages, nextBrief);
    },
    [brief, captionsSuffix, chatBusy, messages, sendChat, source],
  );

  const handleAnswer = useCallback(
    (question: ClarifyingQuestion, value: string) => {
      if (!source || chatBusy) return;

      const label = question.question.replace(/[\s?？:：]+$/u, "").trim();
      const sentence = label === "" ? value : `${label}: ${value}.`;
      const nextMessages = [
        ...messages,
        makeMessage("user", `${sentence}${captionsSuffix()}`),
      ];

      const answer: Answer = { questionId: question.id, value };
      const nextBrief: Brief = {
        ...brief,
        answers: [
          ...brief.answers.filter((item) => item.questionId !== question.id),
          answer,
        ],
      };

      setMessages(nextMessages);
      setBrief(nextBrief);
      setAnsweredIds((prev) =>
        prev.includes(question.id) ? prev : [...prev, question.id],
      );
      void sendChat(nextMessages, nextBrief);
    },
    [brief, captionsSuffix, chatBusy, messages, sendChat, source],
  );

  const handleRetryChat = useCallback(() => {
    const last = lastSendRef.current;
    if (!last) return;
    void sendChat(last.messages, last.brief);
  }, [sendChat]);

  // --- Brief bar -----------------------------------------------------------

  const handleBriefChange = useCallback((patch: Partial<Brief>) => {
    setBrief((prev) => ({ ...prev, ...patch }));
  }, []);

  const handleMusicChange = useCallback(
    (musicSourceId: string | null, name: string | null) => {
      setBrief((prev) => ({ ...prev, musicSourceId }));
      setMusicName(name);
    },
    [],
  );

  // --- Render job ----------------------------------------------------------

  const startRender = useCallback(async () => {
    const plan = turn?.plan;
    if (!source || !plan || startingJob) return;

    setStartingJob(true);
    setJobStartError(null);

    const payload: CreateJobRequest = { sourceId: source.id, brief, plan };

    try {
      const res = await fetch("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        setJobStartError(
          await apiErrorFromResponse(
            res,
            `EditAi couldn't start that edit (error ${res.status}).`,
          ),
        );
        return;
      }
      const data = (await res.json()) as Partial<CreateJobResponse>;
      if (!data.job) {
        setJobStartError("EditAi couldn't start that edit. Please try again.");
        return;
      }
      setJob(data.job);
      setCancelling(false);
      setPhase("rendering");
    } catch {
      setJobStartError(
        "EditAi couldn't be reached. Check your connection and try again.",
      );
    } finally {
      setStartingJob(false);
    }
  }, [brief, source, startingJob, turn?.plan]);

  useEffect(() => {
    const jobId = job?.id;
    const stage = job?.progress.stage;
    if (!jobId || !stage || isTerminalStage(stage)) return;

    let cancelled = false;
    let timer: number | undefined;

    const tick = async (): Promise<void> => {
      try {
        const res = await fetch(`/api/jobs/${jobId}`, { cache: "no-store" });
        if (res.ok) {
          const data = (await res.json()) as { job: Job };
          if (cancelled) return;
          setJob(data.job);
          if (isTerminalStage(data.job.progress.stage)) return;
        }
      } catch {
        // Transient network blip — keep polling.
      }
      if (!cancelled) {
        timer = window.setTimeout(() => {
          void tick();
        }, JOB_POLL_MS);
      }
    };

    timer = window.setTimeout(() => {
      void tick();
    }, JOB_POLL_MS);

    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [job?.id, job?.progress.stage]);

  useEffect(() => {
    if (!job) return;
    const stage = job.progress.stage;
    if (stage === "done") {
      setPhase("done");
    } else if (stage === "failed") {
      setPhase("error");
    } else if (stage === "cancelled") {
      setJob(null);
      setCancelling(false);
      setPhase(turn?.ready && turn.plan ? "planned" : "briefing");
    }
  }, [job, turn]);

  const cancelRender = useCallback(async () => {
    if (!job || cancelling) return;
    setCancelling(true);
    try {
      await fetch(`/api/jobs/${job.id}`, { method: "DELETE" });
    } catch {
      // The poller will pick up the real state either way.
    }
    setJob(null);
    setCancelling(false);
    setPhase(turn?.ready && turn.plan ? "planned" : "briefing");
  }, [cancelling, job, turn]);

  // --- Resets --------------------------------------------------------------

  const makeAnother = useCallback(() => {
    clearRetryTimer();
    setMessages([]);
    setTurn(null);
    setAnsweredIds([]);
    setJob(null);
    setJobStartError(null);
    setChatBusy(false);
    setChatStatus(null);
    setChatConfigError(null);
    setChatErrorMsg(null);
    setBrief((prev) => ({ ...prev, request: "", answers: [] }));
    lastSendRef.current = null;
    captionsSentRef.current = null;
    setPhase("briefing");
  }, [clearRetryTimer]);

  const startOver = useCallback(() => {
    clearRetryTimer();
    uploadXhrRef.current?.abort();
    uploadXhrRef.current = null;
    pendingFileRef.current = null;
    lastSendRef.current = null;
    captionsSentRef.current = null;
    setSource(null);
    setUploadName(null);
    setUploadLoaded(0);
    setUploadTotal(0);
    setUploadError(null);
    setPrep(INITIAL_PREP);
    setPrepError(null);
    setAnalysisReady(false);
    setMessages([]);
    setBrief(emptyBrief());
    setTurn(null);
    setAnsweredIds([]);
    setCaptionsOn(true);
    setMusicName(null);
    setChatBusy(false);
    setChatStatus(null);
    setChatConfigError(null);
    setChatErrorMsg(null);
    setJob(null);
    setStartingJob(false);
    setJobStartError(null);
    setCancelling(false);
    setPhase("idle");
  }, [clearRetryTimer]);

  const focusComposer = useCallback(() => {
    composerRef.current?.focus();
    composerRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, []);

  // --- Render --------------------------------------------------------------

  const uploadStatus: UploadZoneStatus =
    uploadError !== null ? "error" : phase === "uploading" ? "uploading" : "idle";

  const showBriefing = phase === "briefing" || phase === "planned";
  const showLanding = phase === "idle" || phase === "uploading";

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-20 border-b border-line bg-ink/85 backdrop-blur">
        <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between gap-3 px-4 sm:px-6">
          <div className="flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-accent text-white">
              <SparkleIcon className="h-4 w-4" />
            </span>
            <span className="text-lg font-semibold tracking-tight">EditAi</span>
          </div>
          {!showLanding ? (
            <button
              type="button"
              onClick={startOver}
              className="min-h-[44px] rounded-full px-4 text-sm text-muted transition-colors duration-200 hover:bg-white/[0.06] hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-ink"
            >
              Start over
            </button>
          ) : null}
        </div>
      </header>

      <main className="flex-1">
        {showLanding ? (
          <div className="mx-auto flex w-full max-w-3xl flex-col justify-center px-4 py-12 sm:px-6 sm:py-16">
            <h1 className="text-balance text-center text-3xl font-semibold leading-tight tracking-tight sm:text-5xl">
              Tell EditAi what you want. It edits your video.
            </h1>
            <p className="mx-auto mt-4 max-w-xl text-center text-base text-muted sm:text-lg">
              Drop a video, describe the edit in your own words, and EditAi cuts it
              for you.
            </p>
            <div className="mt-10">
              <UploadZone
                status={uploadStatus}
                fileName={uploadName}
                loadedBytes={uploadLoaded}
                totalBytes={uploadTotal}
                errorMessage={uploadError}
                onFileSelected={startUpload}
                onRetry={retryUpload}
                onDismissError={dismissUploadError}
                onOpenDrive={() => setDriveOpen(true)}
              />
              {driveNotice ? (
                <p
                  role="status"
                  className="mt-4 text-center text-sm text-rose-300"
                >
                  {driveNotice}
                </p>
              ) : null}
            </div>
          </div>
        ) : null}

        {showBriefing && source ? (
          <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 sm:py-8">
            <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_320px]">
              <div className="flex min-w-0 flex-col gap-5">
                <div className="rounded-2xl border border-line bg-panel px-4 py-3 md:hidden">
                  <p className="truncate text-sm font-medium">
                    {source.originalName}
                  </p>
                  <PrepStrip
                    prep={prep}
                    ready={analysisReady}
                    error={prepError}
                    compact
                  />
                </div>

                <BriefBar
                  brief={brief}
                  captionsOn={captionsOn}
                  musicName={musicName}
                  onBriefChange={handleBriefChange}
                  onCaptionsChange={setCaptionsOn}
                  onMusicChange={handleMusicChange}
                />

                <ChatPanel
                  messages={messages}
                  turn={turn}
                  busy={chatBusy}
                  statusLine={chatStatus}
                  configError={chatConfigError}
                  errorMessage={chatErrorMsg}
                  answeredIds={answeredIds}
                  composerRef={composerRef}
                  planSlot={
                    phase === "planned" && turn?.plan ? (
                      <PlanCard
                        plan={turn.plan}
                        starting={startingJob}
                        errorMessage={jobStartError}
                        onStart={() => {
                          void startRender();
                        }}
                        onChange={focusComposer}
                      />
                    ) : null
                  }
                  onSend={handleSend}
                  onAnswer={handleAnswer}
                  onRetry={handleRetryChat}
                />
              </div>

              <aside className="hidden md:block">
                <div className="sticky top-24 rounded-2xl border border-line bg-panel p-4">
                  <video
                    controls
                    muted
                    playsInline
                    preload="metadata"
                    src={source.url}
                    className="w-full rounded-xl bg-black"
                  />
                  <p className="mt-3 truncate text-sm font-medium" title={source.originalName}>
                    {source.originalName}
                  </p>
                  <PrepStrip prep={prep} ready={analysisReady} error={prepError} />
                </div>
              </aside>
            </div>
          </div>
        ) : null}

        {phase === "rendering" && job ? (
          <div className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6 sm:py-16">
            <RenderingCard
              job={job}
              cancelling={cancelling}
              onCancel={() => {
                void cancelRender();
              }}
            />
          </div>
        ) : null}

        {(phase === "done" || phase === "error") && job ? (
          <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 sm:py-12">
            <ResultPlayer
              job={job}
              onAnother={makeAnother}
              onStartOver={startOver}
              onRetry={() => {
                void startRender();
              }}
            />
          </div>
        ) : null}
      </main>

      {driveOpen ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Import from Google Drive"
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-0 backdrop-blur-sm sm:items-center sm:p-6"
          onClick={(event) => {
            // Backdrop click closes; clicks inside the panel must not bubble out.
            if (event.target === event.currentTarget) setDriveOpen(false);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") setDriveOpen(false);
          }}
        >
          <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-t-2xl border border-white/8 bg-panel shadow-2xl sm:rounded-2xl">
            <DrivePicker
              onImported={(imported) => {
                setDriveOpen(false);
                setDriveNotice(null);
                acceptSource(imported);
              }}
              onClose={() => setDriveOpen(false)}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}
