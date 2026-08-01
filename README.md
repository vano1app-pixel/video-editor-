# EditAi

EditAi is an AI video editor: you upload raw footage, describe the edit you want in plain language, and Claude plans the cut while ffmpeg renders it. It handles the whole pipeline locally — probing, transcription, scene and silence detection, planning, and the final MP4 — so nothing leaves your machine except the transcript and analysis summary sent to the planner.

## Quickstart

```bash
cp .env.example .env      # then set ANTHROPIC_API_KEY (required)
                          # and optionally OPENAI_API_KEY for captions
npm install
npm run dev
```

Open http://localhost:3000, drop in a video, and tell EditAi what you want.

Without `ANTHROPIC_API_KEY` the chat endpoint returns `503` and no edit can be
planned. Without a transcription provider (`OPENAI_API_KEY`, or a local
whisper binary via `LOCAL_WHISPER_BIN`) EditAi still works — it plans from
scenes and silences alone, but there are no captions and no word-level cuts.

## How it works

- **Upload** — the browser streams the file straight into a route handler (no
  `multipart/form-data` buffering), which writes it under `STORAGE_ROOT/uploads`
  and kicks off preparation in the background.
- **Probe + extract audio** — `ffprobe` reads duration, resolution, fps,
  rotation, and codecs; `ffmpeg` extracts a mono 16 kHz WAV for the transcriber.
- **Transcribe** — OpenAI Whisper or a local whisper CLI produces a transcript
  with word-level timings. A missing or failing provider is survivable and the
  pipeline continues without one.
- **Scene + silence analysis** — `ffmpeg`'s scene-change and `silencedetect`
  filters find cut points and dead air, which become the planner's map of the
  footage and the renderer's input for tightening pauses.
- **Claude plans the cut** — the transcript, scenes, and silences go to
  `claude-opus-5` as a cached system block; it asks clarifying questions until
  it has enough, then emits a JSON `EditPlan` (clips, captions, zooms,
  transitions, music, silence and filler removal) validated against a schema
  and sanitised server-side before anything is rendered.
- **ffmpeg renders** — each clip is encoded to a uniform intermediate, joined
  with hard cuts or `xfade` transitions, then finished with burned-in ASS
  captions and a ducked music bed. Every optional step has a fallback, so a
  failed zoom or transition degrades to a plain cut rather than a failed job.

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | — | **Required.** Key for the planner. Without it, `/api/chat` returns `503`. |
| `PLANNER_MODEL` | `claude-opus-5` | Model that plans the edit. |
| `PLANNER_EFFORT` | `high` | Planner effort: `low`, `medium`, `high`, `xhigh`, `max`. Lower is cheaper and faster. |
| `MAX_TRANSCRIPT_CHARS` | `400000` | Cap on transcript characters sent to the planner in one request. |
| `TRANSCRIBE_PROVIDER` | `auto` | `auto` picks OpenAI if a key is set, else local whisper, else skips. Force with `openai`, `local`, or `none`. |
| `OPENAI_API_KEY` | — | Optional. Enables hosted Whisper transcription, which is what captions and filler-word removal need. |
| `OPENAI_TRANSCRIBE_MODEL` | `whisper-1` | Hosted transcription model. |
| `LOCAL_WHISPER_BIN` | — | Path to a whisper.cpp / faster-whisper CLI, for self-hosted transcription. |
| `LOCAL_WHISPER_MODEL` | — | Model file passed to that CLI. |
| `STORAGE_ROOT` | `./storage` | Root for uploads, extracted audio, scratch files, renders, and job state. Mount a volume here in production. |
| `MAX_UPLOAD_MB` | `2048` | Upload size ceiling. The route aborts and cleans up mid-stream once exceeded. |
| `FFMPEG_PATH` | bundled `ffmpeg-static` | System ffmpeg build. Recommended in production for hardware encoders and newer filters. |
| `FFPROBE_PATH` | bundled `ffprobe-static` | System ffprobe build. |
| `FFMPEG_TIMEOUT_MIN` | `60` | Wall-clock ceiling for a single ffmpeg invocation. |
| `MAX_CONCURRENT_JOBS` | `1` | Renders allowed to run at once. ffmpeg is CPU-bound; keep this small. |
| `RENDER_MAX_DIMENSION` | `1080` | Long edge of the output. `1920` for delivery, `1080` for speed. |
| `RENDER_FPS` | `30` | Output frame rate. |
| `RENDER_CRF` | `20` | x264 quality; lower is better and bigger. |
| `RENDER_PRESET` | `veryfast` | x264 speed/size preset. |
| `RENDER_VIDEO_BITRATE` | `6M` | Video bitrate hint. |
| `RENDER_AUDIO_BITRATE` | `192k` | AAC bitrate. |
| `PUBLIC_BASE_URL` | `http://localhost:$PORT` | Base URL used to build absolute links in responses. |
| `PORT` | `3000` | Port for `npm start`. |

## Deploying

EditAi is **not serverless**. It needs a long-lived Node host (Fly.io, Render, a
VM, or a container) with two things: a **persistent volume mounted at
`STORAGE_ROOT`**, because uploads, renders, and job state live on disk and are
mirrored back into memory on restart; and **`ffmpeg` and `ffprobe` available**,
either as the bundled static binaries or, preferably, a system build pointed at
by `FFMPEG_PATH` / `FFPROBE_PATH`. Renders routinely run for minutes and hold an
in-process job queue, so platforms with short function timeouts or ephemeral
filesystems will drop work mid-render. Set `MAX_CONCURRENT_JOBS` to match the
host's CPU budget, and size the volume for the footage you expect to keep.
