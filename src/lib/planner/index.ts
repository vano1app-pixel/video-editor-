/**
 * The AI edit planner.
 *
 * One call = one turn of the planning conversation. The model either asks
 * clarifying questions or commits to a plan; either way it answers with a
 * single JSON object matching PLANNER_TURN_SCHEMA, which we then validate and
 * normalise before anyone downstream sees it.
 *
 * Two things matter for cost and reliability here:
 *  - The big context block (transcript, scenes, silences) is a cached system
 *    block. It must stay byte-identical across the turns of one conversation,
 *    which is why buildContextBlock() is deterministic and chat history lives
 *    in messages[] rather than being folded into the prompt.
 *  - Requests stream, so a long transcript can never trip an HTTP timeout.
 */

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

import { ANTHROPIC_API_KEY, PLANNER_EFFORT, PLANNER_MODEL } from "@/lib/config";
import { buildContextBlock, buildSystemInstructions } from "@/lib/planner/prompt";
import { PLANNER_TURN_SCHEMA } from "@/lib/planner/schema";
import { sanitizePlan } from "@/lib/planner/sanitize";
import type {
  Analysis,
  Brief,
  ChatMessage,
  ClarifyingQuestion,
  EditPlan,
  PlannerTurn,
  QuestionKind,
} from "@/lib/types";

const MAX_TOKENS = 16_000;

const ERR_AUTH = "EditAi's AI key is missing or invalid.";
const ERR_BUSY = "EditAi is busy right now — try again in a moment.";
const ERR_PARSE = "EditAi couldn't read the AI's plan. Please try again.";

const FALLBACK_REQUEST = "Here's my video — make something good.";
const NEED_MORE_SUFFIX = "Could you tell me a bit more about what you'd like?";

type ApiMessage = { role: "user" | "assistant"; content: string };
type StreamParams = Parameters<Anthropic["messages"]["stream"]>[0];

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

/** True when an Anthropic key is configured. Without one the planner is off. */
export function plannerAvailable(): boolean {
  return typeof ANTHROPIC_API_KEY === "string" && ANTHROPIC_API_KEY.trim().length > 0;
}

// ---------------------------------------------------------------------------
// Response validation
// ---------------------------------------------------------------------------

const questionSchema = z.object({
  id: z.string().nullable().catch(null),
  question: z.string().nullable().catch(null),
  kind: z.string().nullable().catch(null),
  options: z.array(z.unknown()).catch([]),
  rationale: z.string().nullable().catch(null),
});

const turnSchema = z
  .object({
    reply: z.string().catch(""),
    ready: z.boolean().catch(false),
    questions: z.array(z.unknown()).catch([]),
    plan: z.unknown(),
  })
  .catch({ reply: "", ready: false, questions: [], plan: null });

function toQuestions(entries: unknown[]): ClarifyingQuestion[] {
  const questions: ClarifyingQuestion[] = [];
  const usedIds = new Set<string>();

  for (const entry of entries) {
    const result = questionSchema.safeParse(entry);
    if (!result.success) continue;
    const raw = result.data;

    const text = raw.question === null ? "" : raw.question.trim();
    if (text.length === 0) continue;

    let kind: QuestionKind = "text";
    if (raw.kind === "single" || raw.kind === "multi") kind = raw.kind;

    const options: string[] = [];
    if (kind !== "text") {
      for (const option of raw.options) {
        if (typeof option !== "string") continue;
        const label = option.trim();
        if (label.length > 0 && !options.includes(label)) options.push(label);
      }
      // A choice question with nothing to choose from is just a text question.
      if (options.length === 0) kind = "text";
    }

    let id = raw.id === null ? "" : raw.id.trim();
    if (id.length === 0 || usedIds.has(id)) id = `q${questions.length + 1}`;
    while (usedIds.has(id)) id = `${id}x`;
    usedIds.add(id);

    const question: ClarifyingQuestion = { id, question: text, kind, options };
    const rationale = raw.rationale === null ? "" : raw.rationale.trim();
    if (rationale.length > 0) question.rationale = rationale;
    questions.push(question);
  }

  return questions;
}

function fallbackQuestion(): ClarifyingQuestion {
  return {
    id: "q1",
    question: "What should this edit focus on?",
    kind: "text",
    options: [],
  };
}

// ---------------------------------------------------------------------------
// Message plumbing
// ---------------------------------------------------------------------------

/**
 * Chat history -> Anthropic message params. Consecutive same-role turns are
 * joined (legal either way, but it keeps the cached prefix tidy), and the array
 * is guaranteed to start with a user turn.
 */
function buildApiMessages(messages: ChatMessage[], brief: Brief): ApiMessage[] {
  const cleaned: ApiMessage[] = [];
  for (const message of messages) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    if (typeof message.content !== "string") continue;
    const content = message.content.trim();
    if (content.length === 0) continue;
    cleaned.push({ role: message.role, content });
  }

  const first = cleaned.length > 0 ? cleaned[0] : undefined;
  if (first === undefined || first.role !== "user") {
    const request = typeof brief.request === "string" ? brief.request.trim() : "";
    cleaned.unshift({
      role: "user",
      content: request.length > 0 ? request : FALLBACK_REQUEST,
    });
  }

  const collapsed: ApiMessage[] = [];
  for (const message of cleaned) {
    const last = collapsed.length > 0 ? collapsed[collapsed.length - 1] : undefined;
    if (last !== undefined && last.role === message.role) {
      last.content = `${last.content}\n\n${message.content}`;
      continue;
    }
    collapsed.push({ ...message });
  }

  return collapsed;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

function readStatus(err: unknown): number | null {
  if (typeof err !== "object" || err === null) return null;
  const status = (err as { status?: unknown }).status;
  return typeof status === "number" ? status : null;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function toFriendlyError(err: unknown): Error {
  const status = readStatus(err);
  if (status === 401 || status === 403) return new Error(ERR_AUTH);
  if (status === 429 || status === 529) return new Error(ERR_BUSY);

  const detail = errMessage(err);
  if (/overloaded/i.test(detail)) return new Error(ERR_BUSY);
  if (status !== null && status >= 500) return new Error(ERR_BUSY);

  return new Error(`EditAi's AI planner failed: ${detail}`);
}

// ---------------------------------------------------------------------------
// The turn
// ---------------------------------------------------------------------------

/**
 * Run one planner turn. Resolves with the reply plus either questions or a
 * fully sanitised plan; rejects with a user-safe message on transport or
 * protocol failures.
 */
export async function runPlannerTurn(args: {
  brief: Brief;
  messages: ChatMessage[];
  analysis: Analysis;
  jobId: string;
  sourceId: string;
}): Promise<PlannerTurn> {
  const { brief, messages, analysis, jobId, sourceId } = args;

  if (!plannerAvailable()) throw new Error(ERR_AUTH);

  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

  const params = {
    model: PLANNER_MODEL,
    max_tokens: MAX_TOKENS,
    system: [
      { type: "text", text: buildSystemInstructions() },
      {
        type: "text",
        // Byte-identical across the turns of one conversation -> cache hit.
        text: buildContextBlock(analysis, brief),
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: buildApiMessages(messages, brief),
    output_config: {
      effort: PLANNER_EFFORT,
      format: { type: "json_schema", schema: PLANNER_TURN_SCHEMA },
    },
  } as unknown as StreamParams;

  let message: Anthropic.Message;
  try {
    const stream = client.messages.stream(params);
    message = await stream.finalMessage();
  } catch (err) {
    throw toFriendlyError(err);
  }

  let jsonText: string | null = null;
  for (const block of message.content) {
    if (block.type === "text") {
      jsonText = block.text;
      break;
    }
  }
  if (jsonText === null || jsonText.trim().length === 0) throw new Error(ERR_PARSE);

  let payload: unknown;
  try {
    payload = JSON.parse(jsonText);
  } catch {
    throw new Error(ERR_PARSE);
  }

  const parsed = turnSchema.parse(payload);

  let reply = parsed.reply.trim();
  let ready = parsed.ready;
  let questions = toQuestions(parsed.questions);
  let plan: EditPlan | null = null;

  if (ready) {
    const rawPlan = parsed.plan;
    if (rawPlan !== null && rawPlan !== undefined && typeof rawPlan === "object") {
      try {
        const candidate = sanitizePlan(rawPlan, { jobId, sourceId, brief, analysis });
        if (candidate.clips.length > 0) plan = candidate;
      } catch {
        plan = null;
      }
    }

    if (plan === null) {
      // The model said it was done but gave us nothing renderable.
      ready = false;
      reply = reply.length > 0 ? `${reply} ${NEED_MORE_SUFFIX}` : NEED_MORE_SUFFIX;
    } else {
      questions = [];
    }
  }

  if (!ready) {
    plan = null;
    if (questions.length === 0) questions = [fallbackQuestion()];
  }

  if (reply.length === 0) {
    reply = ready
      ? "Here's the edit I put together."
      : "Tell me a little more and I'll put an edit together.";
  }

  return { reply, questions, ready, plan };
}
