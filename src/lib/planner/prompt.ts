/**
 * Prompt builders for the AI edit planner.
 *
 * Both builders are deterministic: for a given (analysis, brief) pair they
 * produce byte-identical strings, which is what makes Anthropic prompt
 * caching effective across the turns of one planning conversation. Never
 * interpolate timestamps, random ids, or per-request state here.
 */

import { MAX_TRANSCRIPT_CHARS, RENDER_DEFAULTS } from "@/lib/config";
import { DEFAULT_FILLER_WORDS, LENGTH_PRESETS } from "@/lib/types";
import type { Analysis, Brief, LengthPreset } from "@/lib/types";

const SCENE_CAP = 120;
const SILENCE_CAP = 200;

/** Static system instructions. Byte-stable across every call. */
export function buildSystemInstructions(): string {
  const presetLines = (Object.keys(LENGTH_PRESETS) as LengthPreset[])
    .map((key) => {
      const p = LENGTH_PRESETS[key];
      if (key === "long") {
        return `  - "long": ${p.minSec}s or more, free-form (default target ${p.defaultSec}s)`;
      }
      return `  - "${key}": ${p.minSec}-${p.maxSec}s (default target ${p.defaultSec}s)`;
    })
    .join("\n");

  const fillerList = DEFAULT_FILLER_WORDS.map((w) => `"${w}"`).join(", ");

  return [
    "You are EditAi's edit planner: an expert video editor who plans a cut for a talking-style video from its transcript, scene cuts, and silence map (all provided in the context block after these instructions). You never render anything yourself - you emit a machine-readable plan.",
    "",
    "OUTPUT CONTRACT",
    'You always answer with one JSON object: { "reply", "ready", "questions", "plan" }.',
    '- "reply": the message the user sees. Short, friendly, concrete.',
    '- "ready": true only when you are committing to a final plan.',
    '- "questions": clarifying questions. MUST be [] when ready is true.',
    '- "plan": the edit plan. MUST be null when ready is false, and MUST be a complete plan when ready is true.',
    "",
    "CONVERSATION POLICY",
    "- On the FIRST turn of a new request, ask AT MOST 3 sharp clarifying questions, and ONLY when the answer would materially change the edit. The only questions usually worth asking:",
    "  1. Target length - only if it is not locked in the settings.",
    "  2. Platform / aspect ratio - only if it is not locked in the settings.",
    "  3. Tone or what to emphasise (funny vs informative, which topic or moment matters most).",
    '- Give clickable options: use "kind" "single" or "multi" with 2-6 "options". Use "kind" "text" only when free text is genuinely needed (then "options" is []).',
    '- If the brief and locked settings already answer everything, or the user says "just do it" / "you decide" / anything similar, skip questions entirely and go ready=true immediately.',
    "- NEVER ask a second round of questions unless the user's answers contradict each other or the locked settings. After one round of answers, commit: ready=true with a full plan.",
    "",
    "PLAN QUALITY RULES",
    "- Clips must quote real transcript moments: every sourceStart/sourceEnd must cover actual speech visible in the transcript. Never invent timestamps.",
    "- Hook first: open the video with the strongest 1-3 seconds of the whole take - the boldest claim, the punchline, the most curiosity-inducing line - even if that means pulling it forward from later in the source.",
    "- Total output duration must land inside the length-preset window:",
    presetLines,
    "- The USER LOCKED SETTINGS in the context block override anything the user typed earlier in chat. Never ask about, or deviate from, a locked length preset, target duration, or aspect ratio.",
    "- sourceStart/sourceEnd must lie within the media duration. Snap cuts to word boundaries: start about 0.15s before the first word begins, end about 0.2s after the last word ends. Do not start a clip mid-sentence unless it is a deliberate hook.",
    "- Prefer cutting inside silences or at scene boundaries - it hides the cut.",
    "- Keep clips in chronological source order, except when pulling a hook forward is clearly better.",
    "- removeSilence: enabled by default with thresholdDb -34, minSilenceSec 0.6, paddingSec 0.12.",
    `- removeFillers: enabled by default with the standard filler words: [${fillerList}]. Trim the list if the speaker's style depends on some of them.`,
    '- Captions: preset "karaoke" for short/medium vertical output (9:16, 4:5, 1:1); "block" for long-form or 16:9. Sensible colours: primary "#FFFFFF" (white), highlight "#FFD400", outline "#000000", position "bottom". If the context block says NO TRANSCRIPT AVAILABLE, use preset "none" with enabled false.',
    "- Zooms: at most ONE subtle punch-in (fromScale 1.0 -> toScale 1.12) per ~15 seconds of output, placed on emphasis moments. Zoom start/end are on the OUTPUT timeline (after cutting); focusX/focusY are 0..1 with 0.5/0.5 = centre.",
    '- Transitions: hard cuts by default - an empty transitions array is usually correct. Add at most a single "fade" and only when the tone clearly calls for it. atClipIndex is the index of the clip being entered (>= 1).',
    "- Music: set music.enabled true ONLY if the context block says a music track is attached; otherwise enabled must be false. When enabled, use volumeDb around -18 and duckDb around -10 with short fades.",
    `- Resolution: match the aspect ratio with the long edge at ${RENDER_DEFAULTS.maxDimension}px, both dimensions even (the server normalises this anyway).`,
    "",
    "REPLY STYLE",
    "- Short, friendly, concrete. No filler, no hedging.",
    "- When ready=true, the reply summarises the edit in 2-3 sentences: what was kept, the overall shape, and the final duration.",
    "- When asking questions, the reply is a single line of context for them.",
  ].join("\n");
}

/**
 * The large, cacheable context block: media facts, locked settings, scenes,
 * silences, and the transcript. Serialized once, deterministically.
 */
export function buildContextBlock(analysis: Analysis, brief: Brief): string {
  const { media, transcript, scenes, silences } = analysis;
  const sec = (n: number) => (Number.isFinite(n) ? n.toFixed(1) : "0.0");
  const parts: string[] = [];

  parts.push("=== MEDIA FACTS ===");
  parts.push(`Duration: ${sec(media.durationSec)}s`);
  parts.push(
    `Frame size: ${media.width}x${media.height}` +
      (media.rotation !== 0 ? ` (rotation metadata ${media.rotation} degrees)` : ""),
  );
  parts.push(`FPS: ${Number.isFinite(media.fps) ? media.fps.toFixed(2) : "unknown"}`);
  parts.push(`Audio: ${media.hasAudio ? "yes" : "no"}`);
  parts.push(
    brief.musicSourceId !== null
      ? "Music track attached: YES - the user attached a music track; music may be enabled."
      : "Music track attached: no - do NOT enable music.",
  );

  parts.push("");
  parts.push("=== USER LOCKED SETTINGS (set in the UI; override anything typed in chat) ===");
  parts.push(`Length preset: ${brief.lengthPreset ?? "not locked"}`);
  parts.push(
    `Target duration: ${
      brief.targetDurationSec !== null ? `${brief.targetDurationSec}s` : "not locked"
    }`,
  );
  parts.push(`Aspect ratio: ${brief.aspectRatio ?? "not locked"}`);

  parts.push("");
  if (scenes.length === 0) {
    parts.push("=== SCENES ===");
    parts.push("No scene cuts detected.");
  } else {
    const shown = scenes.slice(0, SCENE_CAP);
    parts.push(`=== SCENES (${scenes.length} total; start-end in seconds) ===`);
    parts.push(shown.map((s) => `${sec(s.start)}-${sec(s.end)}`).join(", "));
    if (scenes.length > SCENE_CAP) {
      parts.push(`(+${scenes.length - SCENE_CAP} more scenes not shown)`);
    }
  }

  parts.push("");
  if (silences.length === 0) {
    parts.push("=== SILENCES ===");
    parts.push("No silences detected.");
  } else {
    const shown = silences.slice(0, SILENCE_CAP);
    parts.push(`=== SILENCES (${silences.length} total; start-end in seconds) ===`);
    parts.push(shown.map((s) => `${sec(s.start)}-${sec(s.end)}`).join(", "));
    if (silences.length > SILENCE_CAP) {
      parts.push(`(+${silences.length - SILENCE_CAP} more silences not shown)`);
    }
  }

  parts.push("");
  parts.push("=== TRANSCRIPT ===");
  if (transcript === null || transcript.segments.length === 0) {
    parts.push(
      "NO TRANSCRIPT AVAILABLE - plan cuts using scenes/silences only and set captions preset none",
    );
  } else {
    const includeWords = transcript.text.length <= MAX_TRANSCRIPT_CHARS;
    parts.push(`Language: ${transcript.language}`);
    if (!includeWords) {
      parts.push(
        "NOTE: transcript is large - per-word timing omitted; timestamps below are segment-level only.",
      );
    }
    for (const segment of transcript.segments) {
      const text = segment.text.replace(/\s+/g, " ").trim();
      parts.push(`[${sec(segment.start)}-${sec(segment.end)}] ${text}`);
      if (includeWords && segment.words.length > 0) {
        const words = segment.words
          .map((w) => `${w.text.trim()}[${w.start.toFixed(2)}-${w.end.toFixed(2)}]`)
          .join(" ");
        parts.push(`  words: ${words}`);
      }
    }
  }

  return parts.join("\n");
}
