# Causons — Voice-First Language Tutor

A browser-based AI conversation partner for language learners. Speak into the mic, get a natural-sounding reply, and have your grammar gently corrected — all driven by your own API keys, with zero infrastructure to run.

Causons currently supports **French, Spanish, German, Italian, Portuguese, Russian, Dutch, Polish** and **Japanese, Mandarin, Arabic, Korean** in beta.

```
mic → STT (Groq Whisper) → chat (OpenAI gpt-4o-mini, streamed) → TTS (OpenAI tts-1, streamed MP3) → speaker
```

---

## Why this exists

Most language apps either lock you into a specific curriculum or rely on a generic chatbot that praises every sentence as "great!". Causons is the opposite: it's a single-screen conversation surface that

- **Speaks freely** in the target language and listens back,
- **Corrects only objective grammar mistakes** (never punctuation, accents, register, or style — they're transcription artifacts, not user choices),
- **Adapts to a personal knowledge base** of due topics and known weak spots, so the conversation steers toward what you actually need to practice,
- **Costs about $0.04 per 15-minute session** end-to-end across all three providers.

There is no backend, no account, no database. Everything — config, KB, chat history, custom prompt — lives in your browser.

---

## Try it locally

Requirements:

- **Node.js 20+** (any recent LTS)
- **A Groq API key** for speech-to-text — sign up at <https://console.groq.com>
- **An OpenAI API key** for chat + text-to-speech — sign up at <https://platform.openai.com>

```bash
npm install
npm run dev
```

This starts a Vite dev server (TanStack Start, with the Cloudflare runtime adapter active in dev). Open the URL it prints — typically `http://localhost:3000` — and:

1. Go to **Settings** and paste both API keys. They're validated against the providers before being saved.
2. Pick your **practice language** and TTS voice.
3. (Optional) Import a **KB file** to personalize the conversation. See the Guide page in-app for the JSON shape.
4. Go to **Practice** and press-and-hold the mic button to talk.

Keys are stored only in your browser (`localStorage`). They're sent directly to Groq and OpenAI from the client — never to any server controlled by this project.

---

## Deploy

The app is built and shipped as a **Cloudflare Worker** via `wrangler`. The TanStack Start build emits both the SSR Worker entry and the client bundle in one step.

```bash
# Build the worker + client assets
npm run build

# Deploy to Cloudflare Workers
npx wrangler deploy
```

`wrangler.jsonc` is the deploy manifest. Out of the box it sets:

| Key | Value |
|---|---|
| `name` | `language-speech-practice` (rename to your own worker name) |
| `compatibility_date` | `2025-09-24` |
| `compatibility_flags` | `nodejs_compat` (required by the TanStack Start server entry) |
| `main` | `@tanstack/react-start/server-entry` |

You will want to:

1. Rename `name` to whatever you want the worker to be called.
2. Authenticate `wrangler` once with `npx wrangler login`.
3. (Optional) Add a custom domain in the Cloudflare dashboard under Workers → your-worker → Triggers.

**No server-side environment variables are needed.** All credentials are entered by the end-user in the Settings page and stored in their own browser. The Worker only serves static assets and SSR-renders the routes; it never sees an API key.

The build output also includes a `dist/` directory that can be served from any static host (Vercel, Netlify, S3 + CloudFront, etc.) if you'd rather skip Cloudflare — TanStack Start's adapter system supports multiple targets. The Cloudflare path is the one that's wired up and tested.

---

## Building blocks

The app is intentionally small — under ~3,000 lines of hand-written TypeScript across the routes and core libs. The big architectural choices are documented in [`ARCHITECTURE.md`](./ARCHITECTURE.md); this section gives the map.

### Per-turn pipeline (`src/routes/index.tsx`)

The practice page is one component that orchestrates one chat turn end-to-end:

1. **Capture** — `MediaRecorder` collects mic audio into Blob chunks while the user holds the button.
2. **Transcribe** — the Blob is POSTed to Groq Whisper (`whisper-large-v3`) with a language hint.
3. **Stream chat** — `streamGroqChat` (`src/lib/groq-stream.ts`) opens an SSE chat completion against OpenAI's `/v1/chat/completions` and emits sentence-level chunks as they cross a punctuation boundary. The first chunk flushes early (on any natural pause ≥25 chars) so audio starts as fast as possible.
4. **Speak** — each sentence is immediately enqueued onto a `TtsQueue` (`src/lib/tts-queue.ts`). The queue fires `/v1/audio/speech` requests in parallel but plays back in enqueue order, streaming MP3 bytes through a `MediaSource` so playback starts before the response has fully downloaded.
5. **Cache for replay** — each sentence's MP3 blob is also captured at its enqueue index. The replay button on the latest assistant bubble plays from this cache with zero network cost.

### Prompt composition (`src/lib/prompt-store.ts`)

The system prompt sent to the LLM is composed at chat time from two sources of truth:

- **User-editable prose** — `ROLE`, `WHEN TO CORRECT`, `HOW TO CORRECT`, `CONVERSATION STYLE`, `CONVERSATION LEVEL`. Persisted in IndexedDB so the user can edit it in Settings.
- **Data-derived sections** — `LANGUAGE` (from the dropdown), `NAME USAGE`, `TARGET STRUCTURES`, `KNOWN WEAK SPOTS`, `ADDITIONAL INSTRUCTIONS` (all from the imported KB file). These are *stripped* from whatever was saved and *rebuilt fresh* on every turn, so a stale dropdown or a KB edit can never leak into a response.

Section ordering is also deliberate: the stable prefix (ROLE → LANGUAGE → static teaching policy) goes first so it stays cache-friendly across turns; date-volatile content (today's due topics) comes last.

### State persistence

No backend → all state is browser-local.

| Store | Key(s) | What it holds |
|---|---|---|
| `localStorage` | `fvt_config` | name, API keys, language, TTS voice/speed |
| `localStorage` | `fvt_kb`, `fvt_kb_meta` | imported KB JSON + import metadata |
| `localStorage` | `fvt_level` | conversation level (beginner / intermediate / advanced) |
| `localStorage` | `fvt_theme` | dark / light |
| IndexedDB | `fvt_prompt_db.prompts` | the user-editable system prompt |
| Module memory | `src/lib/conversation-state.ts` | current chat history (survives route changes; reset on full reload) |

### Multilingual support (`src/lib/language-config.ts`)

Adding a new language is a single-table edit. Each entry pairs the user-facing label with the ISO code passed to Groq Whisper, the TTS voice IDs to use, and a native-language persona block. The settings dropdown renders from `Object.values(LANGUAGES)`; nothing else needs to change.

---

## Project structure

```
src/
├── routes/                # TanStack Router file-based routes
│   ├── __root.tsx         # Shell, top nav, footer, theme provider
│   ├── index.tsx          # Practice page — mic, chat, TTS, replay
│   ├── settings.tsx       # API keys, language, voice, KB import, prompt editor
│   ├── instructions.tsx   # Guide page (markdown-driven)
│   ├── setup.tsx          # First-run onboarding
│   └── unlock.tsx         # Optional PIN unlock screen
├── components/
│   ├── ChatBubble.tsx     # One message bubble (user / assistant / correction)
│   ├── MicButton.tsx      # Press-and-hold mic control
│   ├── HugoAvatar.tsx     # Animated speaking-state avatar
│   └── ui/                # Minimal shadcn primitives (button, input, label, accordion)
├── lib/
│   ├── tts-queue.ts       # Streaming TTS via MediaSource + per-sentence cache
│   ├── groq-stream.ts     # SSE chat completion streamer w/ sentence splitter
│   ├── prompt-store.ts    # System prompt composition + IndexedDB persistence
│   ├── language-config.ts # Per-language config table (STT/TTS/prompt strings)
│   ├── conversation-state.ts  # Module-level chat history (route-stable)
│   ├── markdown-guide.tsx # Shared markdown rendering for the Guide page
│   ├── app-state.tsx      # Shared ChatMessage type
│   └── utils.ts           # `cn` Tailwind class merger
├── content/
│   └── instructions.md    # The Guide page prose, edited as markdown
├── assets/                # Static images (avatar)
├── routeTree.gen.ts       # Generated by TanStack Router — do not edit
├── router.tsx             # Router wiring
└── styles.css             # Tailwind + theme tokens
```

---

## Costs

Per 15-minute session, with default settings and an average reply length:

| Stage | Provider | Approx. cost |
|---|---|---|
| Speech-to-text | Groq `whisper-large-v3` | ~$0.005 |
| Chat | OpenAI `gpt-4o-mini` | ~$0.015 |
| Text-to-speech | OpenAI `tts-1` | ~$0.020 |
| **Total** | | **~$0.04** |

Costs scale with session length and reply verbosity. The conversation history is hard-capped at the last 16 exchanges (8 turns) to bound input tokens; KB content is capped at 8 due topics and 12 weak spots per turn.

---

## Privacy

- **Your keys stay in your browser.** They go from `localStorage` straight to Groq and OpenAI over HTTPS. The Cloudflare Worker that serves the SSR shell never receives them.
- **Your conversations stay in your browser.** Chat history is kept in module memory and wiped on full reload. It is never persisted server-side.
- **Your KB file stays in your browser.** It's parsed client-side into `localStorage` and reread at chat time. No upload, no sync.
- **Third-party data flow** is whatever Groq and OpenAI do with the requests you make to them; consult their respective privacy policies.

---

## Contributing & customizing

A few hooks worth knowing about if you want to extend or fork:

- **Swap the LLM provider.** The chat call is one `fetch` in `src/lib/groq-stream.ts`. Any OpenAI-compatible endpoint works.
- **Swap the TTS provider.** Replace the `/v1/audio/speech` call in `src/lib/tts-queue.ts`. The MediaSource pump expects MP3 frames; change the MIME and the format flag if you go elsewhere.
- **Change the correction policy.** Edit the default `WHEN TO CORRECT` / `HOW TO CORRECT` text in `src/lib/prompt-store.ts`, or let your users do it in the Settings textarea.
- **Add a language.** Append an entry to `LANGUAGES` in `src/lib/language-config.ts` and the union type above it. Nothing else needs to change.

For the deeper why-and-how — vendor split rationale, audio-streaming postmortems, prompt-pipeline evolution — see [`ARCHITECTURE.md`](./ARCHITECTURE.md).
