# Architecture

This document captures the architectural decisions, trade-offs, and reasoning
behind the **Causons French Voice Tutor** project. It covers what was chosen,
what was considered and rejected, and why — so future changes can be made
without re-deriving the analysis each time.

Where the *intended* design and the *current* implementation diverge (notably
in the security layer), the document calls this out explicitly rather than
papering over it.

---

## Table of Contents

1. [Overview](#1-overview)
2. [System at a Glance](#2-system-at-a-glance)
3. [Project History](#3-project-history)
4. [Top-Level Choices](#4-top-level-choices)
5. [Storage Architecture](#5-storage-architecture)
6. [Prompt Pipeline](#6-prompt-pipeline)
7. [Audio Pipeline](#7-audio-pipeline)
8. [Multilingual Support](#8-multilingual-support)
9. [Cost Profile](#9-cost-profile)
10. [Security & Privacy](#10-security--privacy)
11. [Platform & UX Choices](#11-platform--ux-choices)
12. [Open Decisions](#12-open-decisions)
13. [Bug Postmortems](#13-bug-postmortems)
14. [System-Level Alternatives Considered & Rejected](#14-system-level-alternatives-considered--rejected)
15. [File Map](#15-file-map)
16. [Data Flow — One Chat Turn](#16-data-flow--one-chat-turn)
17. [Maintenance Notes](#17-maintenance-notes)

---

## 1. Overview

Causons is a single-user, voice-first language tutor delivered as a web app.
A turn flows:

```
mic → STT (Groq Whisper) → chat completion (OpenAI gpt-4o-mini) → TTS (OpenAI tts-1) → speaker
```

The interesting architectural surfaces are:

- **Vendor split** — which provider does each pipeline stage
- **Prompt composition** — how user-editable instructions and KB data are combined
- **Audio streaming** — minimizing time-to-first-audio
- **Local-first state** — config, KB, and chat history all live in the browser
- **Multilingual reach** — one architecture, ten supported languages

The trade-offs in this doc reflect a deliberate bias toward **low cost,
low latency, and zero infrastructure**, accepting the constraints that come
with a client-only app (keys in the browser, no central rate limiting, no
cross-device sync).

---

## 2. System at a Glance

```
┌──────────────────────────────────────────────────────────────────────────┐
│  Browser (single page)                                                   │
│                                                                          │
│  ┌────────────┐    ┌──────────┐    ┌────────────┐    ┌──────────────┐    │
│  │ Mic / MR   │ →  │ STT call │ →  │ Chat call  │ →  │ TTS queue    │    │
│  │ (WebAudio) │    │ (Groq)   │    │ (OpenAI)   │    │ + MediaSource│    │
│  └────────────┘    └──────────┘    └────────────┘    └──────────────┘    │
│         │                                  │                  │          │
│         ▼                                  ▼                  ▼          │
│  ┌──────────────────────────────────────────────────────────────────┐    │
│  │  Local state                                                     │    │
│  │  • localStorage:  fvt_config, fvt_kb, fvt_kb_meta, fvt_level,    │    │
│  │                   fvt_theme                                      │    │
│  │  • IndexedDB:     fvt_prompt_db.prompts (custom system prompt)   │    │
│  │  • Module refs:   persistedMessages, persistedConversation       │    │
│  └──────────────────────────────────────────────────────────────────┘    │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘
              │                            │                       │
              ▼                            ▼                       ▼
       Groq STT API                OpenAI chat API          OpenAI TTS API
       (whisper-large-v3)          (gpt-4o-mini, SSE)       (tts-1, streamed MP3)
```

No backend, no database, no auth server. Deployed as a Cloudflare Worker
serving SSR-rendered routes; client-side TanStack Router takes over after
hydration.

---

## 3. Project History

A short chronology of how the current stack was reached. The reasoning for
each migration is preserved in §4 and §14.

| Phase | What changed | Why |
|---|---|---|
| v0 | Originally scaffolded in Lovable | Fastest path from prompt to polished React UI |
| v1 | LLM: Groq Llama 3.3 70B → OpenAI gpt-4o-mini | Llama hallucinated grammar corrections on common French colloquialisms — prompt engineering couldn't fix the underlying knowledge gap |
| v1 | TTS: Azure Cognitive Services → OpenAI tts-1 | Azure forced migration off its free tier; consolidating to a single OpenAI key reduced setup friction |
| v2 | Host: Lovable subdomain → Cloudflare Workers via TanStack Start | Self-hosted edge deploy, no platform lock-in for distribution |
| v2 | Prompt pipeline refactor | KB data baked into saved prompts went stale; moved to runtime composition (see §6.1) |
| v2.1 | Cost-optimization pass | Per-turn token usage dominated by history; trimmed history cap 40→16, capped KB items (top 8 topics / 12 weak spots), reordered sections for cache-prefix friendliness, compressed base-prompt prose ~25%. Net ~45% per-turn chat-cost reduction (see §6 and §9) |
| v2.2 | Audio latency pass | Reduced "user stops speaking → first audio plays" from ~2–6 s to ~0.8–2.5 s via streaming TTS through MediaSource, earlier first-chunk flush, and preconnect (see §7) |
| v2.3 | Buffer-underrun fix | First audio of a session sounded sped-up and jammed because `audio.play()` started before the SourceBuffer caught up. Now we wait for `canplay` before exposing the audio element to the queue (see §7.1) |
| v2.4 | Language-switch bug fixes | Two distinct bugs: `getEffectiveLanguage` priority made the dropdown a silent no-op when a KB was loaded; `replaceLanguageInPrompt`'s regex anchor was stale after the v2.1 prose-tightening. Inverted the priority, dual-anchored the regex, made dropdown and KB import go through a single helper (see §8) |
| v2.5 | Doc consolidation | Renamed `PROMPT_ARCHITECTURE.md` → `ARCHITECTURE.md`, integrated all prior decision notes, and made the security/privacy section honest about what's shipped vs. designed (see §10) |
| v2.6 | Desktop layout pass | App was uniformly `max-w-lg` (512 px). Added responsive widening so chat / instructions reach `max-w-4xl` (896 px) on xl viewports; settings stops at `max-w-2xl` since wide form inputs look stretched (see file diffs in `src/routes/*.tsx`) |
| v2.7 | Per-message replay with audio cache | Added a small play button on the latest assistant bubble. The v1 implementation re-fetched TTS on every click (~2× cost for the replayed message and slightly different prosody). v2 caches each sentence's MP3 Blob during the original chat turn and replays from the cache — zero TTS round-trip, identical audio, free (see §7.8) |
| v2.7 | TTS character normalization | OpenAI tts-1 stumbled when the model used French guillemets («/») inline (e.g. `« du »`). Strip them inside `TtsQueue.fetchTts` before sending to TTS; chat bubble still shows them (see §13.4) |
| v2.8 | Language-switch hardening (round 2) | Even after the v2.4 fixes, a French session that switched to Russian could still reply in French because the saved prompt's language reference can drift outside the regex anchor. Pulled chat history out of `index.tsx` into `src/lib/conversation-state.ts` and made `applyLanguageChange` clear it whenever the language actually changes (see §13.6) |
| v2.9 | Drop the regex entirely, treat language as data | Replaced the regex-based language replacement with section-based dynamic composition. `ROLE AND LANGUAGE` was treated as a dynamic section — stripped from saved prompts, rebuilt fresh from the dropdown each turn. Eliminated the regex but over-corrected: the role *prose* was now also overwritten on every turn, so users couldn't customize it any more (see §13.6) |
| v3.0 | Split ROLE and LANGUAGE into two sections | `ROLE` becomes a user-editable section (default: "You are a friendly conversation partner. Catch genuine grammatical errors..."). `LANGUAGE` becomes a separate single-sentence dynamic section ("Conduct the entire conversation in {X}.") that's stripped/rebuilt. The user can now customize ROLE freely without affecting language. One-time migration: prompts using the legacy "ROLE AND LANGUAGE" header are renamed to "ROLE" on load (any embedded language word is harmless because the freshly-prepended LANGUAGE section is authoritative) |
| v3.1 | Restore "don't correct punctuation" emphasis | Model started flagging missing periods as errors in an Italian session — the v2.1 prose-tightening had demoted the "speech transcript, not written text" framing to a parenthetical, weakening the behavioral guardrail. Rewrote `WHEN TO CORRECT` to lead with the framing as a standalone sentence, put the negative instruction (do-not-correct list) first, and ended with "When in doubt, do not correct." Also added a defensive strip of leading em-dashes / hyphens from TTS chunks to handle the audio stumble at "? » —" boundaries that the spurious corrections were producing (see §13.7) |
| v3.2 | Restore "don't acknowledge correct sentences" emphasis | Same v2.1 prose-tightening root cause, second symptom. The original "treat it as invisible — only its meaning matters" framing in `HOW TO CORRECT` was compressed down, losing the "in any way" / "treat it as invisible" anchors. Model started saying "yes, that's correct" or "well said" on correct sentences. Restored the explicit prohibition with concrete negative examples ("never say things like 'yes, that's right', 'well said', 'perfect'…"). See §13.7's second instance |
| v3.3 | UI polish: top nav, footer tip link, Guide from markdown | Three independent UX touches. (a) Moved the nav from bottom to top with `sticky top-0`; consolidated the theme toggle and GitHub icon from the practice page's own header into the shared `TopNav` so every page gets them. (b) Added a "Buy me a coffee" link with a Coffee icon next to "Contact me" in the footer (paypal.me/AShelaev). (c) Extracted the Guide page content into `src/content/instructions.md` rendered through `react-markdown` so prose can be edited without touching JSX — see §11.5 |
| v3.4 | First-syllable clip on cold sessions | User reported that the first 2–3 audios of a fresh session were missing the opening syllable ("Bon" in "Bonjour"). Same root cause family as v2.3 but a different failure mode: `canplay` was firing too eagerly on bursty cold-cache chunks. Replaced the canplay wait with an explicit ≥300 ms buffered-audio wait in `TtsQueue.fetchTts`. Subsequent audios in a warm session reach the threshold instantly, so steady-state latency is unchanged. Also added a defensive `audio.currentTime = 0` reset right before returning. See §13.3 follow-up |
| v3.5 | Correction reasons leaked into English | Model started returning the reason-between-em-dashes part of corrections in English even though the practice language was Italian. The 1-sentence `LANGUAGE` directive wasn't loud enough to override the model's default of treating "explanations" as matching the language of the instruction-prose (English). Strengthened `LANGUAGE` to enumerate every part of a response that must be in the target language (reply / corrected phrase / reason / example / explanation) and to explicitly forbid switching to English even for grammar explanations. Also tightened the `HOW TO CORRECT` default template with the same constraint for new users. See §13.8 |
| v3.6 | Replay played sentences out of order | The replay cache from v2.7 was being populated in TTS-fetch-completion order (via `onAudioReady` push), not enqueue order. Parallel fetches resolve out of order when sentence lengths differ, so multi-sentence replies replayed in a shuffled-by-length order. Threaded a monotonic `index` from `TtsQueue.enqueue` through `fetchTts` and into the `onAudioReady` callback signature; the orchestrator now slots each blob at its index instead of pushing. See §13.9 |
| v3.7 | Replace French guillemets with straight quotes in the prompt | TTS pronunciation issues around `«»` persisted even with the v2.7 TtsQueue strip in place. Rather than continuing to fight character normalization after the fact, switched the system prompt to instruct the model to use straight `"…"` for correction wrappers. Removes the round-trip "produce `«»` → strip before TTS" and the conditions for any related artifacts. The `TtsQueue.fetchTts` strip is kept as a defensive backup for users with saved custom prompts. See §13.10 |
| v3.8 | Tighter playback-readiness gate | The v3.4 buffer wait (300 ms) was just barely enough on cold sessions; intermittent slow-arriving chunks could still let `play()` start with marginal lead time, mangling audio at the start of a response. Raised the buffered threshold to 600 ms, AND-combined it with `audio.readyState >= HAVE_FUTURE_DATA` so the browser also agrees it can play forward without stalling. Added a 50 ms polling interval as a backup in case the MSE `progress` event timing is uneven. Also changed the defensive `currentTime` reset to seek to `audio.buffered.start(0)` instead of blindly to 0, so MP3 encoder-padding or decoder-delay offsets don't snap forward into audible content. See §13.3 follow-up |
| v3.9 | Strip leading quote characters from TTS chunks | After v3.8, mangling persisted at the start of *some* mid-response sentences — specifically when the streaming sentence-splitter cut a chunk that happened to begin with a `"` (e.g. `"Faccio" si usa …` as the second TTS chunk of a correction-with-multiple-quoted-words). tts-1 produces a small lead-in artefact when a chunk starts on a quote character. Extended the existing leading-em-dash strip in `TtsQueue.fetchTts` to also strip leading whitespace + dashes + quote-like characters of every flavor (straight `"` / `'`, curly `“ ” ‘ ’`, guillemets `« »`). The natural inter-chunk pause already provides the separation the leading mark was visually conveying. See §13.11 |
| v3.10 | Generalize chunk-start strip from enumeration to character class | The v3.9 strip enumerated specific delimiter families. Replaced with a Unicode property-class strip — `/^[^\p{L}\p{N}]+/u` — that removes *any* leading non-letter / non-digit character (quotes, dashes, parens, bullets, math symbols, emoji, anything that can land on a sentence boundary). Accented letters and digits are preserved. Mid-text punctuation is left alone because tts-1 needs it for prosody. One rule that future-proofs against the whack-a-mole pattern. See §13.11 follow-up |
| v3.11 | Same strip on the trailing edge | The v3.10 leading strip handled the chunk-start case but missed the symmetric problem on the trailing edge. When a chunk ends with `." —` (closing quote + em-dash, typical of correction format), tts-1 tries to interpret the dangling punctuation with no following content and produces a choppy ending. The choppy end smears into the inter-chunk pause and sounds like the *next* chunk's start is broken. Added `/[^\p{L}\p{N}.?!…]+$/u` to also strip trailing non-alphanumeric characters — preserving terminal punctuation (`.?!…`) which carries sentence-ending intonation. Leading and trailing strips together clean both chunk edges. See §13.11 follow-up |
| v3.12 | Wait for SourceBuffer.updating before MediaSource.endOfStream | The pump in `TtsQueue.fetchTts` called `mediaSource.endOfStream()` immediately after `reader.read()` returned `done`. But the *last* `appendBuffer(value)` from the previous loop iteration left `sourceBuffer.updating === true`, and `endOfStream()` throws `InvalidStateError` if any SourceBuffer is updating. The throw was caught and silently swallowed. Net effect: MediaSource never transitioned to "ended", the audio's duration stayed at +Infinity, `audio.onended` never fired, and `playNext` blocked on the unfulfilled promise until the browser's internal stall timeout (~30 s) eventually fired `audio.onerror`. The user heard this as a long pause after every sentence. Extracted a `finalizeStream()` helper that awaits `updateend` before calling `endOfStream()`, and changed the silent catch into a `console.warn` so similar failures are visible. Used in both the happy path and the catch handler. See §13.12 |

---

## 4. Top-Level Choices

### 4.1  Vendor split: Groq for STT, OpenAI for chat + TTS

**Choice.** STT goes to Groq's hosted Whisper-large-v3. Chat and TTS go to
OpenAI's `gpt-4o-mini` and `tts-1` with the `nova` (female) and `onyx`
(male) voices.

**Why STT on Groq.**

- Whisper inference on Groq's LPUs is consistently faster than the same
  model on OpenAI's hosting — typically 200–500 ms for a short utterance
  vs. 800–1500 ms.
- Same model, identical accuracy.
- ~$0.00185/min — the cheapest Whisper hosting available.
- STT latency sits at the very front of the perceived response time, so
  the win compounds.

**Why chat on OpenAI gpt-4o-mini.** Originally the project used Groq's
Llama 3.3 70B for cost reasons. Llama repeatedly hallucinated grammar
corrections — flagging correct colloquial expressions (`comment ça va`,
`on peut se tutoyer`, `qu'est-ce que tu fais`) as errors and inventing
grammatical justifications. Extensive prompt engineering didn't resolve
this because the underlying issue was incomplete knowledge of colloquial
grammar, not instruction-following.

`gpt-4o-mini` has significantly better language knowledge and
instruction-following for this task. Per-session cost is comparable to
Llama in practice (~$0.015 per 15-minute session). It's the cost/quality
sweet spot.

**Why TTS on OpenAI tts-1.** The predecessor was Azure Cognitive Services
(free tier: 500k chars/month) — dropped when Azure forced migration off
the free tier. `tts-1` was the natural successor for three reasons:

1. Shares an API key with `gpt-4o-mini`, reducing setup to two keys total.
2. `nova` and `onyx` adapt to any input language automatically — no
   language-specific voice mapping logic required.
3. ~$15/1M characters = ~$0.02–$0.03 per session.

**Per-component alternatives considered and rejected.**

| Component | Alternative | Verdict |
|---|---|---|
| Chat | Groq Llama 3.3 70B | Rejected — hallucinated colloquial-form corrections |
| Chat | GPT-4o (not mini) | Rejected — 10–15× pricier with marginal quality gain for this task |
| Chat | Claude Sonnet | Rejected — strong grammar knowledge but adds a third API provider |
| Chat | DeepSeek | Rejected — untested for multilingual grammar correction reliability |
| Chat | GitHub Models (gpt-4o-mini free tier) | Documented as a no-cost option for users who want it — same model, different base URL and token |
| TTS | Azure paid tier | Rejected — same cost as OpenAI TTS, adds regional config + separate key |
| TTS | ElevenLabs | Rejected — best voice quality but $5/mo minimum and a third API key |
| TTS | Browser `speechSynthesis` | Rejected — free but quality varies wildly by OS and browser, especially outside English |

**Trade-offs of the split.**

- Two API keys to manage in settings (mitigated: both validated on save).
- Two billing surfaces and two failure modes per turn.
- No single "uptime" — degradation on either side surfaces partially.

### 4.2  Client-only architecture

**Choice.** All logic runs in the user's browser. API keys live in browser
storage. There is no application backend.

**Why.**

- Single-user app, no concurrency, no shared resource to coordinate.
- No backend = no server cost, no auth flows, no key rotation drama, no
  rate-limiting infrastructure to build.
- All practice data (config, KB, conversation history) stays on the
  user's device unless they explicitly upload a KB.

**Trade-offs and accepted risks.**

- **Keys are reachable from any script running on the page.** Mitigation
  is narrow attack surface: no third-party scripts loaded, no
  user-generated HTML rendered.
- **No central rate limiting.** The user pays directly, so abuse isn't a
  meaningful concern.
- **No remote logs.** Useful for privacy; bad for production debugging.
- **No cross-device sync.** Acceptable for a personal tool.

Encrypting persisted keys with a PIN-derived AES key (with WebAuthn as
an alternative unlock) is a planned v2 enhancement — see §10.3.

### 4.3  Deploy target: Cloudflare Workers via TanStack Start

**Choice.** TanStack Start (file-based routing + SSR) builds for the
Cloudflare Workers runtime via `@cloudflare/vite-plugin`.

**Why.**

- Edge SSR for fast first paint everywhere.
- Free tier comfortably handles personal use.
- No server processes to maintain.
- No platform lock-in for distribution (the previous host, Lovable, owns
  the subdomain — moving off freed deployment).

**Trade-offs.**

- Workers runtime is a subset of Node — anything that needs `fs`,
  long-running processes, or large native modules can't be added on the
  server side. Not a constraint for this app (everything heavy happens
  in the browser).
- File-based routing locks routing semantics to TanStack. Fine — the API
  is small and the routes are few.

---

## 5. Storage Architecture

Three storage tiers, each chosen for a specific characteristic:

| Tier | Scope | Used for | Why this tier |
|---|---|---|---|
| `localStorage` | Per-origin, synchronous, ~5 MB | `fvt_config` (API keys, voice, speed, language, name), `fvt_kb` (parsed KB JSON), `fvt_kb_meta` (filename + sync time), `fvt_level`, `fvt_theme` | Synchronous reads on every chat turn; values are small; survival across sessions |
| `IndexedDB` (`fvt_prompt_db.prompts`) | Per-origin, async, large capacity | Custom system prompt edited in Settings | Prompt strings can grow long; async API avoids any concern about main-thread blocking; survives session like localStorage |
| Module-level refs (`persistedMessages`, `persistedConversation` in `src/routes/index.tsx`) | Per-app-instance, in-memory | Chat history visible in the UI and conversation array sent to the LLM | Cheap pub/sub between the Index route and any navigation away/back to it; deliberately ephemeral — clears on full page reload |

**Why mix localStorage and IndexedDB.** The split is pragmatic, not
ideological. localStorage's sync access is convenient for reading config
in the middle of the chat pipeline. IndexedDB is only used for the one
case (the editable prompt) where an async access pattern was already
fine and capacity could matter.

**Why conversation history isn't persisted to disk.** Language practice
sessions are ephemeral by design. Persisting transcripts adds storage
complexity, privacy considerations, and IndexedDB management overhead for
no clear user benefit. Each browser session starts fresh; the module-ref
state survives in-app navigation (e.g. Settings → back to Practice) but
resets on reload.

**"Clear All Data" in Settings** (`src/routes/settings.tsx`) wipes both
localStorage keys *and* deletes the IndexedDB database. This is the
single canonical reset path; keep it in sync with any future storage
addition.

**Trade-offs.**

- localStorage is synchronous and main-thread; the largest item is the
  KB JSON (capped at 5 MB on upload, see §10.2) which can introduce a
  noticeable parse pause for pathological KBs. The cap defends against
  this.
- Encrypt-at-rest (PIN-derived AES-256-GCM with the encrypted blob in
  IndexedDB) is a planned v2 enhancement; v1 stores config and KB as
  plaintext localStorage — see §10.

---

## 6. Prompt Pipeline

### 6.1  How does KB content enter the system prompt?

**Problem.** The original implementation baked KB content into the saved
custom prompt at "build time" (when the user opened settings or saved
edits). Two bugs followed:

1. Uploading a KB file did not refresh the textarea on the settings page,
   so the prompt the user saw was frozen on whatever was there before.
2. Once a custom prompt was saved, it was loaded verbatim on subsequent
   sessions, completely shadowing any later KB upload.

Net effect: KB uploads silently had no impact after the first time the
prompt was saved.

**Options considered.**

| Option | Description | Verdict |
|---|---|---|
| A. Always rebuild on KB import | Re-render the textarea with a fresh KB-derived prompt every upload | Rejected: blows away user's custom edits |
| B. Rebuild only if no custom prompt | Safe, but custom prompt stays stale relative to current KB | Rejected: silent staleness is the original bug |
| C. Runtime composition | KB is never baked into the saved prompt; appended at chat time | **Chosen** |

**Choice: C — runtime composition.**

`prompt-store.ts` exposes:
- `buildBaseSystemPrompt(level?)` — the editable base (no KB)
- `buildKbAddendum()` — the KB-derived sections (or empty string)
- `composeFinalPrompt(base)` — strips any KB sections from the input and
  inserts a fresh addendum before `CONVERSATION LEVEL`
- `stripKbSections(prompt)` — defensive migration utility

**Reasoning.**

- Single source of truth for KB data: `fvt_kb` in localStorage. The prompt
  always reflects the latest upload without needing user intervention.
- The user's custom prompt is preserved verbatim across KB changes.
- No prompt-engineering coupling between the two concerns — base is
  semantic, addendum is data.

**Trade-offs.**

- Every chat turn reads localStorage to rebuild the addendum. Cheap
  (synchronous, single-key access).
- Reserved section headers (`LANGUAGE`, `NAME USAGE`,
  `TARGET STRUCTURES`, `KNOWN WEAK SPOTS`, `ADDITIONAL INSTRUCTIONS`)
  cannot appear in a user-authored custom prompt — they get stripped
  by `stripKbSections` and rebuilt fresh at chat time. The user-editable
  sections (`ROLE`, `WHEN TO CORRECT`, `HOW TO CORRECT`, `CONVERSATION
  STYLE`, `CONVERSATION LEVEL`) are preserved verbatim. See §6.7 for
  the broader pattern.

### 6.2  Section ordering for prefix-cache friendliness

**Problem.** OpenAI's automatic prefix cache discounts cached tokens but
only for the byte-identical prefix at the front of the prompt.

Stability tiers:

- **Always stable**: ROLE, WHEN TO CORRECT, HOW TO CORRECT, CONVERSATION STYLE
- **Stable until KB / settings change**: NAME USAGE, ADDITIONAL INSTRUCTIONS
- **Date-volatile**: TARGET STRUCTURES, KNOWN WEAK SPOTS (filtered by today's date)
- **User-togglable mid-session**: CONVERSATION LEVEL

**Constraint.** CONVERSATION LEVEL must remain the last section, by
deliberate priming choice — putting it last makes it the most recent
guidance the model sees before generating.

**Final order.**

```
ROLE → WHEN → HOW → STYLE → NAME → ADDITIONAL INSTRUCTIONS
                                        → TARGETS → WEAK SPOTS → LEVEL
```

This is the best cacheable prefix achievable without violating the
LEVEL-last design rule. Cache hits now extend through
`ADDITIONAL INSTRUCTIONS` rather than cutting off at `CONVERSATION STYLE`
— roughly 100–200 more tokens cached per turn at typical KB sizes.

**Open decision** — moving LEVEL earlier would extend the cacheable
prefix further. See §12.1.

### 6.3  Conversation history retention

**Problem.** Chat-completion APIs are stateless: every turn re-sends the
full conversation history. History tokens accumulate linearly.

| Cap | Tokens / turn | Quality risk |
|---|---|---|
| 40 (original) | ~2000 | None |
| 16 (chosen) | ~800 | Low — long stories may lose deep context |
| 8 | ~400 | Real — short-term memory feels lossy |

**Choice: 16 messages (8 exchanges).**

For a 2–3 sentence tutor reply, useful context rarely spans more than 8
exchanges. ~1200 input tokens saved per turn versus the original cap,
every turn, forever — the single largest cost lever in the app at steady
state.

### 6.4  KB content caps

`prompt-store.ts`:

```ts
const MAX_DUE_TOPICS = 8;
const MAX_WEAK_SPOTS = 12;
```

A 2–3 sentence response cannot meaningfully target more than a handful
of structures per turn. KB growth is unbounded by design (user keeps
practicing and adding entries), so capping the addendum decouples KB
size from prompt size.

**Trade-off.** Cap is FIFO over the filtered (`next_review <= today`)
list — not priority-sorted. See §12.3.

### 6.5  Prose tightness and design principles

ROLE, WHEN, HOW, STYLE sections and KB intros were compressed (~25%
shorter). Meaning-preserving only — no behavioural rule was dropped.

**Reasoning.** These tokens are paid on every turn, forever (~130 tokens
saved per turn at steady state). Tighter prose is also a quality
improvement — less redundancy gives the model fewer chances to over-fit
on one phrasing over another.

**Underlying design principles** (encoded in the section content):

- Corrections fire only for objectively wrong grammatical forms — not
  punctuation, capitalization, accents (transcription artifacts), word
  choice, register, or tone.
- The test for correction is "would a native speaker say this in casual
  conversation?" — colloquial expressions are never errors.
- **False corrections are worse than missed corrections.** A pedantic
  tutor that flags correct usage destroys trust faster than one that
  occasionally lets an error slide.
- If a sentence is correct, the model never acknowledges correctness —
  it responds to the meaning only.
- On multiple errors in one sentence, the model fixes the most
  fundamental one. Priority: verb form/tense > auxiliary > reflexive
  pronoun > agreement > preposition.

**Trade-off.** Future edits must preserve section headers exactly
(`ROLE`, `LANGUAGE`, `WHEN TO CORRECT`, `HOW TO CORRECT`,
`CONVERSATION STYLE`, `CONVERSATION LEVEL`) because `replaceLevelInPrompt`,
`replaceLanguageInPrompt`, `stripKbSections`, and `composeFinalPrompt`
all use them as anchors for section identification.

### 6.6  Read-only KB

**Choice.** The voice app reads the KB JSON but never writes to it.

**Reasoning.** The KB is owned by an upstream tutoring system (Claude
Cowork) that manages spaced-repetition state, SM-2 interval calculations,
and weak-spot tracking. Those require careful rule-based updates that
the voice app has no business performing. Writing from here would risk
corrupting SM-2 state.

The voice app's role is to *consume* the KB for personalization —
reading due topics and weak spots into the system prompt — not to
maintain it.

**Sync mechanism.** The user re-imports the JSON via a file picker when
the upstream system has produced an updated file. Last-sync time is shown
in Settings so they know when to re-sync.

A planned enhancement uses the File System Access API
(`showOpenFilePicker` → persistent `FileSystemFileHandle` cached in
IndexedDB) to auto-re-read the file on each session on Chrome/Edge,
keeping the manual flow as a fallback on Safari/Firefox. **Not yet
implemented** — see §12.5.

### 6.7  Dynamic sections vs. editable sections

**Principle.** Every section in the system prompt belongs to exactly
one of two categories — and the codebase keeps them strictly separate.

- **Editable sections** are user-owned prose: the saved prompt in
  IndexedDB carries them verbatim, the textarea in Settings shows
  them, and chat-time composition uses them as-is. Today: `ROLE`,
  `WHEN TO CORRECT`, `HOW TO CORRECT`, `CONVERSATION STYLE`,
  `CONVERSATION LEVEL`.
- **Dynamic sections** are data-driven, owned by their source of
  truth (settings dropdown or KB file). They are stripped from any
  loaded saved prompt and rebuilt fresh at chat time. Today:
  `LANGUAGE` (from the language dropdown), `NAME USAGE` /
  `ADDITIONAL INSTRUCTIONS` / `TARGET STRUCTURES` / `KNOWN WEAK SPOTS`
  (all from the KB file + config).

**Composition order at chat time** (in `composeFinalPrompt`):

```
1. ROLE                        ← editable
2. LANGUAGE                    ← dynamic, inserted right after ROLE
3. WHEN TO CORRECT             ← editable
4. HOW TO CORRECT              ← editable
5. CONVERSATION STYLE          ← editable
6. NAME USAGE                  ← dynamic (if name set)
7. ADDITIONAL INSTRUCTIONS     ← dynamic (if KB has them)
8. TARGET STRUCTURES           ← dynamic (date-volatile)
9. KNOWN WEAK SPOTS            ← dynamic (date-volatile)
10. CONVERSATION LEVEL         ← editable, kept last by design
```

`LANGUAGE` is anchored directly after `ROLE` so the two read as a
unit at the top of the prompt. The KB addendum sits between
`CONVERSATION STYLE` and `CONVERSATION LEVEL` so the prefix-cache
benefits documented in §6.2 still apply.

**Granularity lesson.** Treating "language" as data is correct; an
earlier attempt (v2.9) treated the combined `ROLE AND LANGUAGE`
section as a single dynamic block, which steamrolled user
customizations to the role prose. The fix (v3.0) was to split that
section into two — `ROLE` (editable) and `LANGUAGE` (dynamic) — so
the categorization happens at the right granularity. The full saga,
including the regex-based language replacement that this pattern
replaces, is in §13.6.

**Implications for future sections.**

- A section that contains *only* data driven by a control (dropdown,
  setting, file) → make it dynamic, strip-and-rebuild.
- A section that contains user-customizable behavior → make it
  editable, save verbatim, never overwrite.
- A section that mixes both → split it. Use one section per category.

The split mirrors a trust boundary: one side belongs to the user,
the other to the system. Each side is composed independently and
they meet only at chat-time assembly.

---

## 7. Audio Pipeline

The perceived latency of "user finishes speaking → first audio of
response plays" is the most important UX metric in a voice tutor. The
following changes pull that number down from ~2.0–6.0 s on the original
implementation to ~0.8–2.5 s.

### 7.1  Streaming TTS via MediaSource Extensions

**Problem.** The original `TtsQueue.fetchTts` awaited the **full**
ArrayBuffer from `/v1/audio/speech` before creating an Audio element and
playing. For a typical 2–3 sentence reply, the first audio chunk could
not play until ~500–1500 ms after the LLM emitted the sentence —
solely because we were waiting for OpenAI to finish generating the
entire MP3.

**Choice.** Pump MP3 bytes from the response body's `ReadableStream`
into a `MediaSource` that's attached to the Audio element. The browser
starts playback as soon as it has enough buffered frames (~25–50 ms of
audio = ~1–2 MP3 frames).

**Implementation summary** (`src/lib/tts-queue.ts`):

```
fetchTts(text)
├─ POST /v1/audio/speech with response_format: "mp3"
├─ if MediaSource not supported: fall back to ArrayBuffer → Blob (legacy path)
├─ else:
│   ├─ create MediaSource, attach to new Audio element
│   ├─ await sourceopen
│   ├─ addSourceBuffer('audio/mpeg')
│   ├─ start background pump: read chunks, appendBuffer to source buffer
│   ├─ wait for ALL of:  buffered ≥600 ms  AND
│   │                    readyState ≥ HAVE_FUTURE_DATA  AND
│   │                    a 50 ms polling fallback ticks
│   │   (or 2 s safety timeout) — gives both the orchestrator and the
│   │   browser confidence that playback will start cleanly from frame 0
│   ├─ audio.currentTime = audio.buffered.start(0) (defensive seek)
│   ├─ on stream end: mediaSource.endOfStream()
│   └─ return audio element (pump continues in background)
```

The audio element is returned once the source buffer has at least
600 ms of audio *and* the browser agrees it can play forward without
stalling (or a 2 s safety timeout elapses). The pump continues
populating the source buffer in the background while playback
proceeds. The next stage (`playNext`) then calls `audio.play()`.

**Why an explicit duration, not just `canplay`.** The first version
of this fix waited for the browser's `canplay` event — meant to
fire when "enough" future data is available to play smoothly. In
practice the browser's heuristic for "enough" can be a single
MP3 frame (~26 ms), which is *not* enough on cold connections.
The first 2–3 audios of a session would either stutter (the
original v2.3 symptom) or have their opening syllable clipped (a
later-discovered failure mode — see §13.3 follow-up).

**Why a combined check, not just a buffer threshold.** The v3.4 fix
used a 300 ms buffered threshold alone, which was right on the edge:
intermittent slow chunks could still let `play()` start with marginal
lead time. The v3.8 design raises the threshold to 600 ms *and*
AND-combines it with `audio.readyState >= HAVE_FUTURE_DATA`, so both
the orchestrator (buffer depth) and the browser (playback safety)
have to agree. A 50 ms polling interval backs up the event
listeners in case `progress` event timing for MSE is uneven.

The defensive `currentTime` seek uses `audio.buffered.start(0)`
rather than blindly assigning 0, so any MP3 encoder padding or
decoder-delay accounting that pushes the buffered range off zero
doesn't cause the browser to snap forward into audible content.

At steady state (warm HTTP/2 connection, chunks flowing), both the
600 ms threshold and `HAVE_FUTURE_DATA` are reached near-instantly,
so subsequent audios in the same session pay no extra latency.

**Key consequence.** The old "preload next while current plays" logic is
removed — it's no longer necessary because every audio element starts
buffering at enqueue time, so by the time the playing one ends the next
one usually has data ready.

**Trade-offs.**

- Same `tts-1` model, same per-character pricing. Strictly a delivery
  change — no cost impact.
- Browsers without MSE/MP3 support fall back automatically to the old
  buffered path.
- Streaming consumes a `ReadableStream` reader for the lifetime of the
  audio — abort handling has to cancel both the reader and the audio
  element.

### 7.2  Earlier first-chunk flush in streaming LLM output

**Problem.** The chat stream is split into sentences by
`SENTENCE_END = /([.?!…])\s/g`. The TTS queue can't fire until a full
sentence is detected. For a correction reply like:

```
« Je vais à Paris » — small grammar reason. Example sentence.
```

The first sentence boundary (the period) is far into the response —
~50–60 characters in. That meant ~800–2500 ms of LLM streaming before
the first audio could even be requested.

**Choice.** For the **first chunk only**, broaden the punctuation set
that triggers a flush:

```ts
const SENTENCE_END = /([.?!…])\s/g;
const FIRST_CHUNK_BOUNDARY = /([.,;:?!…—])\s/g;  // wider
const MIN_FIRST_CHUNK_CHARS = 25;
```

After the first chunk has been emitted, the splitter reverts to the
sentence-only regex.

The 25-character minimum prevents pathologically short clips (e.g.
`Oui,`) from being sent to TTS, where they sound clipped.

**Effect.** A correction now flushes its first audio after `» —`
(~22 chars + trailing space and dash) instead of waiting for the first
period. Roughly 200–500 ms saved on the very first audio of a response.

**Trade-off.** The first audio chunk can end on a comma or em-dash,
producing a brief pause before the next sentence speaks. In practice
this is natural speech rhythm — not perceptibly worse than a
sentence-end pause.

### 7.3  Connection pre-warming via `<link rel="preconnect">`

**Problem.** The first request to OpenAI or Groq pays the cost of DNS
lookup + TCP handshake + TLS handshake — typically 100–300 ms before
the request even starts.

**Choice.** Add preconnect links in the root document head:

```html
<link rel="preconnect" href="https://api.openai.com" crossOrigin="anonymous" />
<link rel="preconnect" href="https://api.groq.com" crossOrigin="anonymous" />
```

The browser opens the underlying connections as part of page load. The
first real API request reuses the warmed connection.

**Trade-offs.**

- Zero cost — `preconnect` is pure transport-layer setup. No HTTP
  request is sent, no API spend, no rate-limit consumption.
- Saving applies only to the first request of the session; subsequent
  requests already benefit from browser connection pooling.

### 7.4  STT path

A single POST to Groq's `/openai/v1/audio/transcriptions` endpoint with
the recorded blob, model `whisper-large-v3`. Groq's Whisper is
consistently fast (200–500 ms for short utterances) so no
streaming/chunking is needed at this stage.

The recorded audio uses a `MediaRecorder` mimetype fallback chain
(`audio/webm;codecs=opus → audio/webm → audio/mp4 → audio/mpeg`) for
cross-browser compatibility. See §11.2.

### 7.5  Sentence-level TTS pipelining

The TTS queue starts an HTTP request **per sentence** as soon as the
LLM stream emits a boundary. Because the chat completion is streamed
(`stream: true`), boundary detection happens in parallel with the model
still generating. Multiple TTS calls can be in flight simultaneously;
the queue plays them in order.

This is a deliberate choice over a single "wait for full reply, then
TTS the whole thing" approach: it overlaps LLM time-to-last-token with
TTS time-to-first-byte, instead of paying them sequentially.

**Limitation.** Sentence-boundary detection on `.?!…` followed by
whitespace can be fooled by abbreviations, decimal numbers, and unusual
punctuation. For conversational tutor output (the actual domain) these
are rare enough not to matter in practice.

### 7.6  Latency budget: before vs. after

Order-of-magnitude estimates for **time from mic release to first audio
frame playing**, on a warm connection (i.e. not the first turn of a
session):

| Phase | Before optimizations | After |
|---|---|---|
| STT request (Groq) | 200–500 ms | 200–500 ms (unchanged — already fast) |
| LLM time-to-first-token | 500–1500 ms | 500–1500 ms (prefix cache helps on later turns) |
| Wait for first sentence boundary | 800–2500 ms | 200–500 ms (first-chunk flush) |
| TTS request → first audio frame | 500–1500 ms | 50–200 ms (streaming MediaSource) |
| Buffering / `canplay` wait | n/a | ~50–200 ms |
| Audio play setup | 50–150 ms | 50–150 ms |
| **End-to-end** | **~2.0–6.0 s** | **~0.8–2.5 s** |

The biggest single win is the streaming TTS — collapsing the wait for a
full MP3 download into a wait for one decodable MP3 frame. The
first-chunk flush is the second-biggest. Preconnect is small and only
benefits the first request of a session, but it's free.

### 7.7  First-turn cold start

The numbers above describe steady-state behaviour. The very first chat
turn of a session is unavoidably slower because three first-time
requests fire near-simultaneously to two origins:

- **STT** to `api.groq.com`: full TLS handshake + Whisper warmup →
  often 800–1500 ms instead of 200–500 ms.
- **Chat** to `api.openai.com`: cold TLS + cold prefix cache → can be
  1000–2500 ms TTFT instead of 500–1500 ms.
- **TTS** to `api.openai.com`: shares the OpenAI HTTP/2 connection
  with the chat call, so first-byte may be deferred while the chat
  stream takes bandwidth.

Realistic first-turn total: ~1.5–4 s before first audio plays.
Subsequent turns: ~0.8–2.5 s.

**What preconnect actually buys.** `<link rel="preconnect">` triggers
DNS + TCP + TLS handshake during page load, ahead of the first actual
request. The browser keeps the warmed connection idle and reuses it.
This shaves ~100–300 ms off the first request — meaningful but it
cannot eliminate the first-token latency of the LLM itself, which is
the largest first-turn cost.

**Levers left for further cold-start reduction** (none are taken
today):

- A throwaway "warmup" request to the OpenAI chat endpoint at app
  load — would prime the prefix cache and HTTP/2 connection. Costs a
  fraction of a cent per session start; deferred because the cold
  start is tolerable.
- Switching to a vendor with faster cold TTFT (e.g. Groq-hosted LLM).
  Ruled out on quality grounds — see §4.1 and §12.2.
- OpenAI Realtime API. Ruled out on cost — see §14.1.

### 7.8  Replay button & audio cache

**Feature.** The latest assistant message gets a small play button in
the bottom-right of its bubble. Click it to re-hear the message.

**Design choice — cache the original audio rather than re-synthesize.**
During the original chat turn, `TtsQueue.fetchTts` already downloads
the full MP3 for each sentence. The streaming path also mirrors every
chunk into a `Uint8Array[]` so that, when the stream finishes, a
`Blob` can be constructed without a second fetch. That Blob fires
through a new `onAudioReady(text, blob)` callback, which the chat
orchestrator pushes into a per-message `audioCacheRef`. When the
TtsQueue drains successfully (`onDone` with `hadError === false`),
the cache flips `complete = true`.

On replay-button click, `handleReplay(messageId, text)`:

1. Looks up the cache for `messageId`.
2. If `cache.complete && cache.blobs.length > 0`, plays the blobs
   back-to-back via a lightweight in-component loop (no TtsQueue, no
   network).
3. Otherwise — cache missing (page reload), incomplete (some sentence
   failed during the original turn), or for a different message —
   falls back to a fresh `TtsQueue` that re-fetches the full message
   text as a single TTS request.

**Why this design.**

- **Zero added cost on the happy path.** The first version of the
  replay button regenerated audio on every click (~2× the TTS cost
  for any replayed message). Worse, the regenerated audio sounded
  different from the original because the original was three
  sentence-scoped TTS calls while the regeneration was one
  message-scoped call — different prosody. Caching makes replay
  free *and* identical to the original.
- **Only the latest message is cached.** Earlier assistant bubbles
  don't get a replay button anyway, so caching their audio would
  burn memory for nothing. When a new assistant message starts, the
  old cache is replaced.
- **Lives in memory only.** Per-message footprint is small (~50 KB
  for a typical 2–3 sentence reply), so even an hour-long session
  fits in a few MB. Persisting to IndexedDB across reloads was
  considered and rejected — the marginal value is low and the
  invalidation logic (what counts as "the same message" after a
  reload?) is fiddly.

**Concurrency.** Replay-from-cache uses its own `replayAbortRef`
`AbortController`, separate from `ttsQueueRef`. New chat turns abort
both. Clicking replay during ongoing playback (whether original or a
prior replay) aborts and restarts cleanly.

---

## 8. Multilingual Support

**Choice.** Ten languages supported, two tiers:

| Tier | Languages |
|---|---|
| Fully supported | French, Spanish, German, Italian, Portuguese, Russian, Dutch, Polish |
| Beta | Japanese, Mandarin, Arabic, Korean |

**Why the tier split.** The limiting factor is LLM grammar-correction
reliability, not STT or TTS coverage:

- Whisper-large-v3 handles all twelve languages well.
- `tts-1` Nova/Onyx adapt to whatever language the input text is in —
  no per-language voice mapping logic required.
- `gpt-4o-mini` performs confidently for Western European languages and
  Russian. East Asian and Arabic languages have less reliable grammar
  correction — the model may miss errors or misapply rules — so they're
  surfaced with a beta label in the Settings dropdown.

**Language resolution priority: settings > KB > default.** The settings
dropdown is the authoritative source of the practice language. KB
language is used at *import time* — `handleKbImport` calls
`applyLanguageChange(data.language)` so a freshly imported KB switches
the language and writes that choice into `fvt_config` — but after
import the user can override the choice via the dropdown without
re-uploading.

Both pathways (dropdown change, KB import) go through the same
`applyLanguageChange` helper in `src/routes/settings.tsx`, which:

1. Calls `persistLanguage(newLang)` — updates React state and writes
   `fvt_config.language` immediately, so a chat turn started before
   clicking "Save Settings" already uses the new language.
2. Runs `replaceLanguageInPrompt` on the textarea — keeps the
   language reference in the user's editable prompt in sync.
3. Persists the updated prompt to IndexedDB if a custom prompt is
   saved.

`replaceLanguageInPrompt` matches both the current prose anchor
("conversation partner in X.") and the legacy pre-prose-tightening
anchor ("Conduct the entire conversation in X."), so prompts saved
under the older wording still get updated.

This priority was previously the reverse (KB always overrode settings
at runtime), which caused the dropdown to silently no-op whenever any
KB was loaded. That was a bug: the dropdown change wrote to
`fvt_config` but `getEffectiveLanguage` only read it as a fallback
behind the KB. Inverted in commit `d5c7d2f`.

### 8.1  Conversation history on language switch

Switching language does **not** auto-clear the conversation history.
Practice continues with the new system-prompt language but the
existing history is preserved. To start fresh, the Practice page has a
"Clear conversation" affordance that calls `handleNewSession`
(`src/routes/index.tsx`) to reset both the UI messages and the
LLM-facing conversation array.

This was a deliberate choice over auto-clear: most language switches
are deliberate (the user knows they're starting a new practice
session), and auto-clearing on every dropdown change would surprise
users who switch briefly to check something. The manual button
preserves user control without forcing a decision.

**The `personaPrompt` field in `language-config.ts`.** Each language
entry has a `personaPrompt` (a localized "you are a friendly native
speaker" persona). This field is defined but **not currently consumed**
anywhere in the runtime — the live system prompt comes from
`buildBaseSystemPrompt` which uses the `promptLang` field for the
language name. The `personaPrompt` is vestigial scaffolding from an
earlier design. Either wire it in or remove it next time
`language-config.ts` is touched.

**Trade-offs.**

- Beta languages will sometimes feel less reliable. Acceptable for
  v1; flagged in UI.
- Adding a new language is a single entry in `LANGUAGES` plus a Whisper
  STT code — cheap to expand.

---

## 9. Cost Profile

### 9.1  Per-turn (chat completion only)

Order-of-magnitude estimates for `gpt-4o-mini` ($0.15 / $0.60 per 1M
input/output tokens; cached input ~$0.075).

**Per turn at steady state** (full history, KB loaded):

| Component | Tokens | Notes |
|---|---|---|
| Base prompt | ~600 | Stable across session |
| KB stable (NAME + EXTRA) | ~100 | Stable across session |
| KB volatile (TARGETS + WEAK SPOTS) | ~250 | Changes daily |
| CONVERSATION LEVEL | ~70 | Stable unless toggled |
| History (16 messages) | ~800 | Sliding window |
| New user message | ~30 | |
| **Total input** | **~1850** | |
| Output | ~150 | 2–3 sentences |

Raw chat cost ~$0.00037 per turn; with prefix caching engaged on the
stable ~700-token chunk, ~$0.00033 per turn. ~45% per-turn chat cost
reduction versus the original code.

### 9.2  Per 15-minute session (everything combined)

At typical conversational pace (~40 turns in 15 minutes, ~150
characters of spoken response per turn, ~5 minutes of mic audio
total):

| Component | Provider / model | Cost / 15-min session |
|---|---|---|
| STT | Groq Whisper-large-v3 | ~$0.03 |
| LLM | OpenAI gpt-4o-mini | ~$0.015 |
| TTS | OpenAI tts-1 | ~$0.025 |
| **Total** | | **~$0.07** |

Daily 15-minute use ≈ $2/month. Daily 30-minute use ≈ $4/month.

TTS dominates per-turn audio cost (~$0.002 per reply), but it scales
linearly with reply length and there's no lever to pull without losing
voice quality.

---

## 10. Security & Privacy

This section is structured as **current implementation** + **intended
design** because they diverge. The intended design is preserved as a
reference for future work; the current state is what's actually shipped.

### 10.1  API key storage

**Current implementation.** Both API keys are stored as plaintext JSON
in `localStorage.fvt_config`. No encryption. Both keys are validated on
save (Groq via `/v1/models`, OpenAI via a minimal TTS request) so the
user knows their keys are real.

**Intended design.** The unlock layer (see §10.3) would derive an
AES-256-GCM key from the user's PIN via PBKDF2 (100k iterations + random
salt) and store the encrypted config + KB in IndexedDB instead of
plaintext localStorage.

**Roadmap.** PIN-derived encryption is a planned v2 enhancement. The
unlock UI scaffolding (`src/routes/setup.tsx`, `src/routes/unlock.tsx`)
is in place; v2 fills in the AES-256-GCM encryption layer described in
§10.3. Scoped out of v1 because the project target — a single-user
personal tool on a trusted device — doesn't materially benefit from
at-rest encryption that an attacker with device access could likely
bypass anyway.

**Trade-off accepted in the meantime.** A client-only app can't truly
hide keys from anyone with access to the device. The mitigations in
place: no third-party scripts load on the page, no user-generated HTML
is ever rendered, "Clear All Data" wipes everything. The risk profile
is "trusted personal device" — appropriate for a personal practice tool.

### 10.2  KB sanitization (prompt-injection defense)

The KB JSON is user-uploaded and ends up directly inside the system
prompt. `prompt-store.ts` mitigates:

- **`sanitizeKbString(text, maxLen)`** strips `«»[]{}<>` characters
  (markers that could simulate prompt sections or angle-bracket
  pseudo-tags) and truncates to a length cap per field.
- **Field-level length caps**: name 50, topic names 100, weak spots
  200 (via the default), instructions 500.
- **Array-level count caps**: 8 due topics, 12 weak spots
  (`MAX_DUE_TOPICS`, `MAX_WEAK_SPOTS`).
- **5 MB file size limit** on KB upload (`settings.tsx`).

This is defense in depth. The real attacker is a malicious KB file
the user might be given — and the model itself remains the final
guard against following injected instructions.

### 10.3  Unlock / authentication (planned for v2)

The unlock UI is in place — `src/routes/setup.tsx` collects a PIN
during onboarding; `src/routes/unlock.tsx` provides a return-visit
gate with Touch ID and PIN options. The encryption layer that would
back them is a planned v2 enhancement. In the current build the
unlock screen navigates on any 4+ digit PIN and setup doesn't persist
a PIN or encrypt the config; v1 ships as "trusted personal device"
(§10.1).

**v2 design.**

- **PIN path.** Derive an AES key from the PIN via PBKDF2 (100,000
  iterations, random salt stored alongside the ciphertext). Encrypt
  `fvt_config` and `fvt_kb` with AES-256-GCM via the Web Crypto API.
  Store ciphertext + salt + IV in IndexedDB.
- **WebAuthn / Touch ID path.** On enrollment, generate a random
  32-byte unlock key; wrap the user's AES key with it via AES-KW;
  register the unlock key as a WebAuthn credential. On unlock, Touch
  ID / Face ID authenticates and unwraps the AES key without the user
  re-entering the PIN.
- **Lockout.** After N failed PIN attempts, freeze for a backoff
  window. The unlock UI already mentions "Too many attempts" — the
  state machine isn't there yet.

**Trade-off when implemented.** PIN re-entry once per session on
devices without biometric support. On Chrome/Edge with Touch ID, a
single tap.

### 10.4  No remote telemetry

The app sends nothing to a server we control. Every network request goes
to one of three vendor APIs (Groq, OpenAI) and carries only the data
required for that call. No analytics, no error reporting, no usage logs.

This is a privacy posture, not an architectural constraint — adding
telemetry later would require a backend, which the project deliberately
avoids (§4.2).

---

## 11. Platform & UX Choices

### 11.1  Microphone permission UX

The browser's permission flow is unforgiving — once "denied", a user
needs to dig into site settings to recover. `src/routes/index.tsx`
mitigates:

- **Pre-flight check** via `navigator.permissions.query({name: "microphone"})`
  on browsers that support it. If state is "denied", surface a long
  toast explaining how to re-enable per-browser, *before* the actual
  `getUserMedia` call burns the user's only retry.
- **Iframe detection** — if `window.self !== window.top`, open the app
  in a new tab and abort the recording attempt. Most browsers refuse
  mic access inside iframes; failing loudly with redirection beats
  silently failing.
- **Specific error messages by DOMException name** — `NotAllowedError`,
  `NotFoundError`, `NotReadableError` get distinct guidance, instead of
  a generic "could not access microphone".

### 11.2  MediaRecorder mimetype fallback chain

```
audio/webm;codecs=opus → audio/webm → audio/mp4 → audio/mpeg
```

Picked by `MediaRecorder.isTypeSupported` in order. Chrome and Firefox
prefer webm/opus (small, fast, low-latency); Safari needs mp4. The
chain ensures recording works in every modern browser without forking
the codepath.

### 11.3  Theme persistence

Light/dark toggle is stored as `localStorage.fvt_theme` and applied via
a class on `<html>`. The initial value is read synchronously inside the
`useState` initializer so there's no flash-of-wrong-theme on hydration.
SSR-safe via a `typeof window !== "undefined"` guard.

### 11.4  TanStack Router file-based routing

Routes live in `src/routes/`, generated into `routeTree.gen.ts` on
build. Pros: routes are obvious from the file tree, no route config to
keep in sync. Cons: locks us into TanStack's routing conventions, which
is fine — the API is small and the routes are few.

### 11.5  Content-driven Guide page

**Choice.** The Guide page (`/instructions`) renders from a markdown
source file (`src/content/instructions.md`) rather than from JSX
inline prose.

**Why.** The Guide is the highest-edit-frequency surface in the app
— it's documentation, not application logic. Forcing every typo or
copy tweak through a JSX file (with escaping, JSX-text rules, and
prettier formatting) is friction with no upside. A `.md` file is
the right substrate for content.

**Mechanism.**

- `src/content/instructions.md` is imported into
  `src/routes/instructions.tsx` via Vite's `?raw` query, which
  inlines the file as a string at build time. No runtime fetch, no
  separate bundle download — the markdown ends up in the lazy-loaded
  `instructions` route chunk alongside the React code.
- A small `parseGuide()` helper splits the string by H1 / H2
  prefixes: `# Heading` is the page title, the paragraph between H1
  and the first H2 is the intro, each `## Heading` becomes one
  accordion section.
- `react-markdown` renders each section's body with component
  overrides that match the previous Tailwind styling (numbered
  lists, bullet lists, bold spans, external-link styling,
  tip-box blockquotes).

**Editing conventions.**

- One `# H1` per file (page title).
- The first paragraph after H1 becomes the page subtitle.
- Each `## H2` is an accordion section. Add a new section by
  adding a new `## …` block; order in the file is order on the
  page.
- `**bold**` for bold; `[text](url)` for external links (auto
  `target="_blank"`); `1.`/`-` for lists; `> 💡 …` for the
  highlighted tip-box callouts.

**Trade-off.** The Guide route chunk grew from a few kB to ~138 kB
client-side because `react-markdown` pulls in `unified`, `mdast`,
and `micromark`. The chat-path bundles (Practice, Settings) are
untouched — those don't import react-markdown. The Guide page is
only fetched when the user opens that tab, so this doesn't affect
chat latency, cold-start cost, or per-turn cost. Acceptable price
for editability.

**When to apply this pattern elsewhere.** Any other long-form
content page (e.g. a future privacy / terms / about page) should
follow the same pattern: source in `src/content/*.md`, render
through the same helpers. Don't apply this pattern to surfaces
where the prose is tightly coupled to dynamic data or interactive
state — those belong in JSX where conditionals and props are
ergonomic.

---

## 12. Open Decisions

Each of these has a clear path forward but needs validation before
adoption.

### 12.1  Move `CONVERSATION LEVEL` out of the trailing position?

**Status.** Currently last, by design choice. Limits the cacheable
prefix to end before TARGETS/WEAK SPOTS.

**If moved between `STYLE` and the KB addendum:**

- Cacheable prefix extends all the way through `CONVERSATION LEVEL`.
- Behavioural risk: the level instruction is no longer the most recent
  context. Modern models aren't strongly position-sensitive on this
  kind of constraint, but worth an A/B before committing.

### 12.2  Model swap to a Groq-hosted LLM?

**Status.** `gpt-4o-mini` hardcoded in `src/lib/groq-stream.ts`.

**Cheaper alternative.** Groq-hosted Llama 3.1 8B (~$0.05 / $0.08 per
1M tokens) — 3–7× cheaper, single vendor for STT and chat.

**Why not yet.** This is the same quality issue that drove the original
Llama → GPT-4o-mini migration (see §4.1). Smaller open models still
miss colloquial-form distinctions in French. Worth retrying with a
held-out test set if a new Groq-hosted model with better multilingual
grammar coverage ships.

### 12.3  Spaced-repetition priority in KB topic selection?

**Status.** Selection is `filter(next_review <= today)` then
`slice(0, MAX_DUE_TOPICS)` in array order — effectively FIFO over the
due-today set.

**If sorted by priority** (e.g. `last_review` ascending, explicit SRS
score):

- Most overdue items get prompt attention.
- Requires a stable priority field in the KB schema, which doesn't
  exist today.

Revisit if/when the upstream KB schema gains a priority field.

### 12.4  Memoize the system prompt build?

**Status.** `composeFinalPrompt` runs every turn, re-reading
localStorage + IndexedDB.

**If memoized** in a ref with invalidation on KB upload / language
change / level change / custom-prompt save:

- Saves ~5–30 ms of async I/O per turn (latency only).
- Adds plumbing to invalidate from settings callbacks.

Skipped because the cost is latency-only and the priority has been
token economy. Revisit if first-token latency becomes a concern.

### 12.5  File System Access API for KB auto-sync

**Status.** KB is re-imported via a manual `<input type="file">` picker
in Settings every time the upstream system updates the JSON.

**Intended.** Use `showOpenFilePicker` once and cache the resulting
`FileSystemFileHandle` in IndexedDB. On each app load, re-read the file
via the cached handle (Chrome/Edge support permission persistence with
user consent). Fall back to the current manual flow on Safari/Firefox
where the API is unavailable.

**Why not yet.** Permission re-prompting nuances differ across browsers
and Cloudflare Workers' Service Worker model needs verification.

### 12.6  PIN / WebAuthn unlock layer

See §10.3. Stubbed. Not blocking current usage but the single biggest
gap between current code and intended security posture.

### 12.7  Per-language error priority ranking

**Status.** The HOW TO CORRECT priority ranking
(`verb form/tense > auxiliary > reflexive pronoun > agreement >
preposition`) is hardcoded in the base prompt — accurate for French and
mostly applicable to other Romance languages, less so for German, much
less for Japanese / Mandarin / Arabic.

**If made language-specific.** A `LanguageConfig.errorPriority` field
that gets injected into the prompt during `buildBaseSystemPrompt`.
Useful once the beta languages move toward stable.

### 12.8  Bidirectional voice API (OpenAI Realtime or equivalent)

End-to-end voice-to-voice via WebSocket would push turn latency below
500 ms. Rejected on cost grounds — see §14.

---

## 13. Bug Postmortems

The polished decision sections above describe the *current* design.
The path to those decisions ran through three significant bugs found
in real use. Each entry below is short on purpose — symptom, root
cause, fix, and the takeaway most worth carrying forward.

### 13.1  KB content never reached the prompt after first save

**Symptom.** User imported a knowledge-base JSON file. The system
prompt looked correct in the settings textarea. On subsequent sessions,
new KB uploads silently had no effect — the prompt stayed frozen on
whatever was saved the first time.

**Root cause.** The original implementation built the full prompt
(including KB-derived sections) and saved that string verbatim to
IndexedDB when the user clicked "Save Prompt". On subsequent loads,
`loadCustomPrompt()` returned the saved string as-is, and the
KB-aware default-prompt builder only ran when there was no saved
string. So any later KB upload was shadowed by the saved prompt's
stale baked-in KB sections.

**Fix.** Split the prompt into a *base* (user-editable, no KB) and a
*KB addendum* (runtime-composed from the latest `fvt_kb`). At chat
time, `composeFinalPrompt(base)` strips any legacy KB sections from
the base and inserts a fresh addendum before `CONVERSATION LEVEL`.
The saved prompt is now language- and behaviour-only; KB data flows
through at every turn. See §6.1.

**Takeaway.** When state has two sources (user-editable text + a
separate data file), don't snapshot the data into the text. Compose
at consumption time.

### 13.2  Language switch silently ignored

**Symptom.** User chose French, practised for a while, switched the
settings dropdown to Russian, returned to Practice — still got French
responses.

**Root cause.** Two independent bugs were both contributing.

*Bug A — priority inversion in `getEffectiveLanguage`.* The function
prioritized `fvt_kb.language` over `fvt_config.language` at runtime,
documented as "KB language overrides the manual selector". This
worked when a user managed multiple KB files (one per language) but
made the dropdown a silent no-op whenever any KB was loaded — the
dropdown wrote to `fvt_config.language`, and `getEffectiveLanguage`
never read it.

*Bug B — stale regex anchor in `replaceLanguageInPrompt`.* The
function anchored its replacement on the literal phrase **"Conduct
the entire conversation in {X}."** — the original ROLE AND LANGUAGE
wording. The v2.1 prose-tightening pass changed the wording to
**"You are a conversation partner in {X}."** without updating the
regex, so the function silently no-op'd on any saved custom prompt.
Even when the user changed the dropdown, the custom prompt's
language reference stayed frozen.

**Fix.**

- Inverted `getEffectiveLanguage` priority to `settings > KB > default`.
  KB language is now used only as a fallback for users who haven't
  visited Settings yet. The KB-language auto-set at import time still
  works — it now writes through to `fvt_config` instead of relying on
  the override.
- Dual-anchored `replaceLanguageInPrompt` to match both the current
  and legacy prose.
- Created `applyLanguageChange(newLang)` in `settings.tsx` so dropdown
  changes and KB imports both go through the same helper. Previously
  they diverged: the dropdown updated the custom prompt; KB import
  did not.
- Added a "Clear conversation" button (`Trash2` icon) on the Practice
  page so the user can explicitly reset the message history when
  switching languages. Auto-clear was deliberately rejected — too
  surprising for a user briefly toggling to check a setting.

**Takeaway.** Regex anchors and the prose they anchor on are
implicitly coupled. Renaming or compressing the prose without
auditing every regex that depends on it produces silent regressions.
Add a search for the anchor phrase to the checklist whenever
prompt prose changes.

### 13.3  First audio of a session sounded sped-up and jammed

**Symptom.** After enabling streaming TTS (v2.2), the very first audio
response of a session arrived late and sounded sped up or chopped.
Subsequent responses were normal.

**Root cause.** `fetchTts` returned the audio element immediately
after `MediaSource.sourceopen` — before any MP3 chunks had been
appended to the SourceBuffer. `playNext` then called `audio.play()`,
which started playback while the buffer was nearly empty. On the
first turn of a session, three cold-cache requests fire
simultaneously (STT, chat, TTS), so MP3 chunks from TTS arrive in
bursts on the still-warming HTTP/2 connection. The browser, trying to
maintain real-time playback sync against a chronically underrunning
buffer, skipped forward — producing the "sped up, jammed" sound.

Subsequent turns were unaffected because the HTTP/2 connection was
warm, chunks streamed evenly, and `audio.play()` had something to
play.

**Fix.** Wait for the `canplay` event (or a 2 s safety timeout) before
resolving the audio element to the queue. The pump continues feeding
chunks in the background; we just delay when `playNext` sees the
audio handle. By the time it does, the browser has enough buffered
for smooth playback. Subsequent audios pay near-zero overhead because
their `canplay` fires immediately against the warm connection. See
§7.1.

**Takeaway.** Streaming a Media Source Extension audio element
requires two synchronization points, not one: (1) the source buffer
must exist before chunks can be appended, and (2) enough chunks must
be appended before `play()` is called. The first design only handled
(1). Tests on a warm cache won't catch the (2) bug — only the first
turn of a fresh session reproduces it.

**Follow-up: `canplay` alone wasn't sufficient.** A later user
reported that the first 2–3 audios of a session were still missing
their opening syllables ("Bon" in "Bonjour" wasn't pronounced),
even with the canplay wait in place. Same root cause family — cold
HTTP/2 connection → bursty MP3 chunks → too little buffered when
playback starts — but a different failure mode this time. `canplay`
fires when `readyState >= HAVE_FUTURE_DATA`, which can be satisfied
by as little as one MP3 frame (~26 ms) of buffered audio. When
playback then begins, MP3 decoder ramp-up plus the browser's audio-
clock lead time consume the first ~100–200 ms of audible content
before the user actually hears anything. That's enough to eat the
first syllable.

Replaced the canplay wait with an **explicit minimum-buffered-
duration** wait: 300 ms of buffered audio (or a 2 s safety timeout).
The check listens on the audio element's `progress` event (which
fires after each successful `appendBuffer`) and on `canplay` as a
secondary trigger, and re-checks `audio.buffered.end(0)` until the
threshold is met. Also added a defensive `audio.currentTime = 0`
right before returning, in case the browser inferred a non-zero
playback start from the buffered range.

Subsequent sentences in a warm session reach the 300 ms threshold
near-instantly, so no extra latency at steady state. Only the
cold-start audios pay the extra wait — and they were the broken
ones anyway.

**Refined takeaway.** Browser "I can play" heuristics for MediaSource
streams are tuned for "can I start *something*", not "can I start
*cleanly*". When the cost of starting badly is audible (clipped
audio at start), don't rely on `canplay`; wait for an explicit
duration of buffered audio. Pick the threshold large enough to
absorb the codec's own ramp-up time (~300 ms is comfortable for
MP3).

**Second follow-up: 300 ms wasn't always enough either.** A later
report described mangled audio at the start of the *response* (not
necessarily the first session) — "in some cases", intermittent. The
300 ms threshold was right on the edge: when a chunk happened to
arrive in a slightly-late burst, `play()` would start with just over
300 ms buffered but the browser's own decoder state hadn't fully
stabilized. Three reinforcements:

1. **Raised the threshold to 600 ms.** Double the previous value;
   well above MP3 decoder ramp-up + browser audio-clock lead time.
2. **AND-combined with `audio.readyState >= HAVE_FUTURE_DATA`.**
   Both conditions must be true. The buffered-duration measures
   *our* lead time; the readyState measures the *browser's* opinion
   of playback safety. Either alone wasn't enough.
3. **Added a 50 ms polling interval** as a backup for the event
   listeners. The MSE `progress` event timing isn't strictly
   defined across browsers; polling guarantees we re-check
   regardless of event delivery.

Also changed the defensive `currentTime` reset to seek to
`audio.buffered.start(0)` instead of blindly to 0. If the MP3
stream's first frame doesn't sit at exactly t=0 (encoder padding
or decoder-delay accounting), setting `currentTime = 0` can cause
the browser to snap forward into audible content. Seeking to the
actual start of the buffered range lands at the first real sample.

Subsequent sentences in a warm session still reach all these
thresholds near-instantly, so steady-state latency is unchanged.

### 13.4  TTS stumbled on inline French guillemets

**Symptom.** Reading a correction reply like *"« Je mange de fromage. »
— Il faut dire « Je mange du fromage. » **On utilise « du »** pour
parler d'une quantité indéfinie de fromage."*, the voice glitched
right before "du" — either pausing too long, fluttering, or producing
a brief audible artifact.

**Root cause.** The system prompt instructs the model to wrap the
corrected phrase in French guillemets (`« phrase » — reason`). This
reads cleanly in the chat UI and works fine for the outer correction
frame, where the `«` sits between paragraphs or after sentence
boundaries. But the model also (correctly, from a writing-standards
perspective) used guillemets *inline* to quote individual words —
`« du »`. OpenAI `tts-1` has trouble with that transition: the `«`
followed directly by a consonant produces inconsistent prosody and
occasional audible glitches.

**Fix.** Strip `«` and `»` from the text **inside `TtsQueue.fetchTts`,
just before sending to the TTS endpoint**, and collapse any
whitespace runs the strip leaves behind. The visible chat bubble
keeps the guillemets so the user can still see the corrected phrase
distinctly. The audio just gets cleaner pronunciation. Doing this in
`fetchTts` (rather than at sentence-emit time) means the replay
button (§13's [Clear conversation] sibling) gets the cleanup for free.

**Takeaway.** What renders well visually doesn't always synthesize
well acoustically. Treat the chat bubble and the TTS input as two
separate render targets — the same source text, different
normalization rules per target. Visual punctuation is for the eye;
TTS input is for the engine. Don't conflate them.

### 13.5  Replay button silently paid for TTS twice

**Symptom.** After adding the replay button on the latest assistant
bubble, a user noticed two things on the second listen of a message:
the intonation sounded slightly different from the original, and
they wondered whether replay was hitting the TTS API again.

**Root cause.** It was. The v1 replay implementation called
`TtsQueue.enqueue(fullMessageText)` and let the queue fetch from
`/v1/audio/speech` again. The new request charged for the same
characters a second time, and because the original was three
sentence-scoped calls while the replay was one message-scoped call,
the prosody seam differed audibly. Two confirmations of the same
underlying mistake — the audio that was already downloaded was
being discarded after playback.

**Fix.** Cache the MP3 bytes during the original turn and replay
from cache. `TtsQueue.fetchTts` now mirrors the response stream into
a `Uint8Array[]` and fires a new `onAudioReady(text, blob)` callback
when the stream ends. The chat orchestrator hooks that callback and
pushes blobs into a per-message `audioCacheRef`. When the queue
drains cleanly (`hadError === false`), the cache is marked complete.
`handleReplay` uses cached blobs when available; falls back to a
fresh TTS call only when the cache is missing or incomplete (e.g.
after a page reload). See §7.8 for the full design.

**Takeaway.** A "play it again" button looks like a UI concern but
its first implementation was actually a network/economics question
in disguise. The version that worked first wasn't the right one —
"works" included an invisible 2× cost. User-reported audio
artefacts ("the intonation is different") were the only signal that
something was paying for what should have been free. Worth assuming
that any "play this again" feature should be cache-from-source by
default, not regenerate-on-demand.

### 13.6  Language switch still bled French into Russian sessions

**Symptom.** User had a French conversation, switched the dropdown to
Russian, clicked Save Settings, reloaded the page. The app then
correctly transcribed Russian speech (STT was using the right
language) but the assistant kept replying in French and explicitly
stated French was its conversation language. Reload meant the
in-memory conversation history was already empty, so the problem
clearly wasn't history bleed — the system prompt itself was
referencing French.

**Root cause.** Two distinct gaps, both around assumptions that
"language change correctly propagated to the saved prompt":

1. **`replaceLanguageInPrompt` could miss the language reference.**
   The regex anchors on two specific phrasings — `conversation
   partner in X` (current prose) and `Conduct the entire conversation
   in X` (legacy prose). Any other phrasing (user-edited prompts,
   future prose revisions, or an unforeseen phrasing in a saved
   prompt) silently bypasses the rewrite, so the saved prompt keeps
   the old language even after a dropdown switch + save.
2. **The conversation history wasn't being explicitly cleared on
   language switch.** A page reload cleared it incidentally
   (module-level state resets), but if the user *didn't* reload —
   switched language in Settings and went straight back to Practice
   — the chat history from the previous language would still be in
   the LLM context array, anchoring the model in the old language.

**Fix — two layers:**

1. **Auto-clear conversation history on language switch.** Pulled
   the previously-private `persistedMessages` /
   `persistedConversation` module state out of `index.tsx` into a
   shared `src/lib/conversation-state.ts`, exposing a
   `clearConversation()` function. `applyLanguageChange` in
   `settings.tsx` calls it whenever the new language differs from
   the current one. French→Russian wipes the French exchanges from
   both the UI message list and the LLM context array — even without
   a page reload.

2. **Stop pattern-matching the language word, treat the section as
   data instead.** First attempt was to add a chat-time
   `replaceLanguageInPrompt` call as a "last line of defence" against
   regex misses. That worked, but didn't address the underlying
   brittleness — the regex was still the only mechanism keeping the
   language fresh, and it was still coupled to specific prose.

   The cleaner version (now shipped): `ROLE AND LANGUAGE` is treated
   the same way as KB sections — it's a **dynamic section** that's
   stripped from the saved prompt and rebuilt fresh at chat time
   from `getEffectiveLanguage()`. `composeFinalPrompt` always
   prepends a freshly-built role section, regardless of what the
   loaded saved prompt contains. `replaceLanguageInPrompt` was
   rewritten to strip the section by header match and prepend a new
   one — no regex on prose anywhere. The settings page on load
   re-prepends a fresh role section to the textarea preview so the
   user sees the current language reflected even after a saved
   prompt is restored.

**Takeaway.** Storing data inside editable text and then trying to
keep it in sync via pattern matching is a category error. The
dropdown is the source of truth for the language; the prompt text
should be *derived* from it, not parallel to it. The fix is
structural: treat language like we already treat KB content — as a
dynamic section that the saved prompt does not own. No regex, no
anchor phrases to drift away from, no "last line of defence"
required because the only thing that ever specifies the language at
chat time is the dropdown itself.

**Follow-up (v3.0): granularity matters.** The first version of this
fix used a single "ROLE AND LANGUAGE" dynamic section — which
correctly fixed the language problem, but also stripped the role
prose on every chat turn. Users could no longer customize the
role/personality section ("you are a stern but supportive tutor…")
because their edits were silently overwritten on the next message.

The right granularity is **two separate sections** sharing the
top-of-prompt position:

- `ROLE` — editable prose owned by the saved prompt. Default:
  "You are a friendly conversation partner. Catch genuine
  grammatical errors, but never sacrifice natural conversation flow
  to over-correct."
- `LANGUAGE` — single sentence, data-driven, stripped+rebuilt from
  the dropdown every turn: "Conduct the entire conversation in
  {currentLanguage}."

`composeFinalPrompt` inserts `LANGUAGE` directly after `ROLE` so the
two read as a unit at the top of the system prompt. The migration
for legacy "ROLE AND LANGUAGE" saved prompts is a header rename
(`ROLE AND LANGUAGE` → `ROLE`); any embedded language word in the
legacy prose is harmless because the freshly-prepended `LANGUAGE`
section is what the model uses.

**Meta-takeaway.** "Treat data as data, not text" is the right
principle but applies at the right grain. A section is the right
unit *if* it contains only data. If it contains both editable
behavior and dynamic data, split it. The split mirrors the trust
boundary: one side belongs to the user, the other to the system.

### 13.7  Prose tightening weakened multiple behavioral guardrails

The v2.1 prose-tightening pass (~25% token reduction across the base
prompt) eliminated load-bearing language from three distinct
behavioral rules. Each came back later as a user-reported
regression. The fixes for all three followed the same template:
restore the original framing, lead with the negative instruction,
add concrete examples of the forbidden behavior.

#### Instance 1 — "Don't correct punctuation" was demoted to a parenthetical

**Symptom.** User said "sto molto bene dove vai?" (Italian) and the
model replied with `« Sto molto bene. Dove vai? » — Aggiungi un
punto per separare le frasi.` — a textbook correction reply with
the "fix" being **add a period**. The prompt explicitly forbids
correcting punctuation, so this should never happen.

**Root cause.** The original `WHEN TO CORRECT` framing was an
explicit standalone clause: *"Do not correct punctuation,
capitalization, or accents — **the user speaks, not types, and
these are transcription artifacts.**"* The tightening pass
compressed this to *"Do not correct punctuation, capitalization,
accents (the user speaks, not types), …"*, demoting the
transcription-artifact reasoning to a parenthetical. The logical
content was preserved but the **pragmatic weight** was not.

**Fix (v3.1).** Rewrote `WHEN TO CORRECT` to lead with the framing
as a standalone first sentence: *"The user input is a speech
transcript. Punctuation, capitalization, and accents are added by
the transcription engine — they are NOT user choices and must never
be treated as errors."* Negative instruction (do-not-correct list)
follows, positive instruction (correct-only-these list) last.
Capped with *"When in doubt, do not correct."*

Also added a defensive `TtsQueue.fetchTts` strip of leading
em-dashes / hyphens / whitespace, because when these spurious
corrections did get produced, the streaming splitter cut them
mid-pattern and the next chunk would start with ` — ` (the
post-strip remnant of `» — `), causing an audible TTS stumble.

#### Instance 2 — "Don't acknowledge correct sentences" lost its anchor

**Symptom.** User reported the model saying things like "your
sentence is correct" or "yes, that's right" when the user spoke
correctly. The original prompt explicitly forbids any acknowledgment
of correctness — the model should respond *only* to the meaning, as
if the sentence had been spoken by a native speaker.

**Root cause.** Original prose: *"If the sentence is correct, reply
naturally with no reference to the user's phrasing, grammar, or
sentence **in any way**. **Treat it as invisible** — only its
meaning matters."* Tightened to: *"If the sentence is correct,
reply naturally with no reference to phrasing or grammar — only the
meaning matters."* Three behavioral anchors disappeared: "in any
way" (intensifier), "treat it as invisible" (concrete metaphor),
and "the user's phrasing, grammar, or sentence" (the exhaustive
list collapsed to "phrasing or grammar"). The model started
interpreting "no reference to phrasing or grammar" as a *narrow*
prohibition — saying "well said!" doesn't reference grammar per se,
so it became fair game.

**Fix.** Rewrote the section to lead with the explicit prohibition
and concrete examples:
*"If the sentence is correct: do not acknowledge it in any way.
Never praise the user's phrasing, never confirm it is correct,
never say things like 'yes, that's right', 'well said', 'perfect',
or any similar validation. Treat the input as invisible — respond
only to its meaning, as a native speaker would in a normal
conversation."*

Concrete negative examples close the loophole that the abstract
prohibition left open.

#### Pattern across both instances

The same compression idiom — moving an intensifier or framing
sentence into a parenthetical, an em-dash aside, or a shorter list —
preserves what the instruction *says* while gutting how it *lands*.
Models give parenthetical content less pragmatic weight than a
leading sentence; they treat exhaustive lists as broader than
abbreviated ones; they need concrete negative examples for tight
prohibitions to stick.

The total token cost of both fixes is ~50 tokens per turn, undoing
about half the v2.1 saving on the affected sections. The cost is
clearly worth it — token economy that breaks behaviour is not a
win.

**Meta-takeaway.** Token-cost compression and behavioral instruction
clarity pull in opposite directions. Future prose passes must treat
**negative-behavioral-guardrails** (anything of the form "never X",
"do not X", "do not acknowledge X") as load-bearing structural
elements, not surface prose:

- Keep them as standalone, leading sentences. Never as appositives,
  parentheticals, or em-dash asides.
- Include concrete negative examples for the forbidden behaviors.
  The model needs anchors more specific than the abstract rule.
- Keep exhaustive lists exhaustive. Don't collapse "phrasing,
  grammar, or sentence" to "phrasing or grammar" — that opens a
  semantic loophole.

Both instances also share a meta-pattern with §13.2's regex-anchor
brittleness: the v2.1 compression optimized for measurable
(tokens) without measuring the downstream behavioral effects.
**Test the bot, not just the build.**

#### Migration limitation (both instances)

These fixes update `buildBaseSystemPrompt`, so new users get the
stronger framing immediately. Users who saved a custom prompt
before this fix still have the weaker prose in their saved text —
`WHEN TO CORRECT` and `HOW TO CORRECT` are user-editable sections
(§6.7), so we don't overwrite them automatically. The opt-in path
is "Reset to Default" on the Settings page. We deliberately don't
auto-overwrite editable sections; that's the trade-off for honoring
user customization.

### 13.8  Correction reasons leaked into English

**Symptom.** During an Italian session, the user said *"Sto molto
bene, che faccio oggi?"* and the model replied:

> « Che cosa faccio oggi? » — **It's important to use "cosa" in
> this context. "Cosa" is the correct pronoun for "what" when
> asking questions.** Ad esempio: "Cosa farai oggi?"
> Hai dei piani per oggi?

The corrected phrase, the example, and the follow-up question were
all in Italian — but the **reason** between the em-dashes came out
in English. Everything else in the conversation had been in Italian
up to that point.

**Root cause.** Same family as §13.7 (a behavioral guardrail
without enough pragmatic weight), but the contradicting context
this time is the prompt's own language. The system prompt is
entirely written in English: the section headers, the WHEN TO
CORRECT / HOW TO CORRECT instructions, the bracketed template
placeholders (`[corrected phrase]`, `[one-sentence reason]`,
`[One short example]`). The `LANGUAGE` section was a single short
sentence — *"Conduct the entire conversation in Italian."* — which
the model can quietly reinterpret in context as *"replies are
Italian, but meta-content like explanations matches the language
of the instructions (= English)"*. The reason-after-em-dash slot
in the correction template is exactly the kind of content the
model classes as "meta-explanation".

This bias got worse after v3.1 and v3.2, when the prose-tightening
restoration added ~50 more tokens of English instruction-prose,
raising the relative weight of "English = explanation language" in
the prompt.

**Fix.** Two reinforcing changes:

1. **Strengthened the `LANGUAGE` dynamic section** to explicitly
   cover every part of a response:

   > Conduct the entire conversation in {X}. EVERY part of your
   > response — the reply, the corrected phrase inside « », the
   > reason given after «—», the example, and any explanation —
   > must be in {X}. Never switch to English or any other language
   > for any part of any response, even when explaining a grammar
   > point.

   Adds ~40 tokens, ships to every user immediately because
   `LANGUAGE` is dynamic (§6.7) — no migration needed.

2. **Tightened the `HOW TO CORRECT` template** to explicitly say
   the three slots must use the conversation's language:

   > … All three of corrected phrase, reason, and example must be
   > in the conversation's language — never in English or in the
   > language these instructions are written in.

   This only affects new users / users who Reset to Default, since
   `HOW TO CORRECT` is editable. Belt-and-braces with the LANGUAGE
   change.

**Takeaway.** When a system prompt is written in one language but
asks the model to respond in another, every instruction that
*describes content* — placeholders, formats, conditions — implicitly
carries the prompt's language as a default. The LANGUAGE directive
has to be loud enough and exhaustive enough to override that
default at every part of the response. A single "respond in X"
sentence is *not* loud enough when the surrounding prose is in
English and template slots like `[reason]` look like they're asking
for an explanation. Enumerate the slots the language applies to
("reply, corrected phrase, reason, example, explanation"), and say
"never switch" explicitly.

This generalizes §13.7's takeaway: behavioral guardrails fight
contradicting signals. Make sure the guardrail outweighs whatever
context could pull the model the other way.

### 13.9  Replay cache shuffled the sentence order

**Symptom.** When the assistant's response was multi-sentence and
the user hit the replay button, the cached audio played the
sentences in what looked like a random order rather than the order
they were written.

**Root cause.** The replay-cache feature (§7.8 / v2.7) populates
the cache by appending each sentence's MP3 blob to a `blobs[]`
array inside `ttsQueue.onAudioReady`. But TtsQueue fires each
sentence's TTS fetch in parallel, on its own MediaSource pipeline,
and `onAudioReady` is the *download-complete* signal — fired in
the order the fetches finish, not the order they were enqueued.

When sentences differ in length, a shorter later sentence often
finishes downloading before a longer earlier one. The cache thus
ended up shuffled into "shortest first" order with no relation to
the actual reading order.

Original playback was unaffected — the queue's `playNext` loop
plays sentences in enqueue order regardless of fetch-completion
order, since it awaits each item's audio promise inside a
sequential `while` loop. Replay only became visible because it
walked the cached array directly.

**Fix.** Each call to `TtsQueue.enqueue` now assigns the sentence
a monotonic 0-based `index` from a counter on the queue. That
`index` is threaded through `fetchTts` and forwarded into the
`onAudioReady` callback signature, which the orchestrator uses to
*slot* each blob at the correct cache position
(`cache.blobs[index] = blob`) instead of pushing in arrival order.
Also added a defensive `if (!blob) continue` in
`playCachedAudio` so any sparse hole (e.g. from a single fetch
error) skips silently rather than throwing.

**Takeaway.** When parallel work feeds a shared collection, never
rely on completion order to imply input order. Pass a sequence id
through with each piece of work and slot the result by id. The
original `push(blob)` looked correct in tests because in dev the
sentences were small and finished in order — the bug only
reproduced when sentence lengths varied enough for the race to
flip. *"Tested it once, looked fine"* is not a substitute for
*"the ordering is structurally guaranteed"*.

### 13.10  Stopped producing French guillemets in the first place

**Symptom.** Audio pronunciation issues around the `«»` in correction
wrappers continued to be reported even after the v2.7 fix that
stripped guillemets inside `TtsQueue.fetchTts` before sending text
to OpenAI TTS. Users would see correctly-formatted corrections
(`« phrase » — reason`) in the chat bubble but hear pronunciation
artefacts in the audio.

**Root cause analysis.** Three candidate explanations:

1. The strip wasn't running. Verified it was — `tts-queue.ts`
   `text.replace(/[«»]/g, "")` is at the top of `fetchTts` before
   any branching.
2. Stale cached audio from before the strip was deployed. Possible
   for users in long-running sessions, but doesn't explain new
   reports.
3. The strip removes the characters but the resulting whitespace
   gap + sudden Italian phrase boundary post-strip produces a
   subtler artefact downstream in the TTS decoder. Hard to
   reproduce deterministically.

**Fix.** Rather than continue to debug character normalization
*after the fact*, removed the upstream cause: changed the system
prompt to instruct the model to wrap corrections in straight
double quotes (`"…"`) instead of French guillemets (`«…»`).

- `buildBaseSystemPrompt`'s `HOW TO CORRECT` template now reads
  `"[corrected phrase]"` and references "the opening straight
  double quote" rather than `«`.
- `buildLanguageSection` no longer mentions `«»` or `«—»` — the
  parts-of-a-response list is now described semantically (the
  reply, any corrected phrase, the reason, examples, any
  explanation).
- `TtsQueue.fetchTts`'s `replace(/[«»]/g, "")` strip is **kept**
  as a defensive backup for users who saved a custom prompt before
  v3.7 — their saved prompt still tells the model to produce
  guillemets, and we don't auto-overwrite editable sections (§6.7).
  Reset to Default on Settings opts in to the new straight-quote
  default.

**Takeaway.** When character normalization fights model output to
get a clean downstream effect, look for ways to change the source
instead. A persistent post-hoc fix means there's a load-bearing
assumption in the pipeline that should be removed. Asking the
model not to produce a problematic character is more robust than
asking the pipeline to remove it cleanly every time. Same
principle as §13.6 (treat data as data, not text): when the
upstream is the source of truth, fix it there.

**Cost.** The chat bubble now shows `"…"` instead of `«…»` for
corrections, which is less typographically native to French /
Italian / other Romance languages where guillemets are the
standard quotation style. Trade-off accepted in exchange for clean
audio and a simpler pipeline.

### 13.11  Leading quote at the start of a TTS chunk mangled the audio

**Symptom.** Multi-sentence response in Italian:

```
"Sto molto bene" — si usa il verbo "stare" per descrivere il proprio stato.
"Faccio" si usa per parlare di azioni.
Un esempio: "Io sto bene." Come è andata la tua giornata?
```

The user heard the **start of the second sentence** (`"Faccio" si usa
per parlare di azioni.`) mangled. The first sentence played cleanly,
and the user had previously noted that straight double quotes worked
fine when they appeared *inside* text.

**Root cause.** The streaming sentence-splitter
(`groq-stream.ts`) cuts at sentence-ending punctuation, producing
self-contained chunks. Each chunk is sent to OpenAI tts-1 as a
separate request. For the response above, the chunks are:

1. `"Sto molto bene" — si usa il verbo "stare" per descrivere il proprio stato.`
2. `"Faccio" si usa per parlare di azioni.`
3. `Un esempio: "Io sto bene." Come è andata la tua giornata?`

Chunk 2 begins with a `"` — and tts-1 produces a brief lead-in
artefact when a chunk starts on a quote character (probably trying
to model the prosodic effect of "this is a quotation" without enough
preceding context). The listener hears this as a mangled opening
syllable. Inside-text quotes are fine because the model has
surrounding context to produce the right intonation.

This is the same class of problem as §13.4 (TTS hiccup on inline
`«»`) — punctuation at a chunk boundary that the streaming splitter
doesn't know to absorb. The v3.7 switch from `«»` to `"…"` removed
the original artefact but moved the boundary to a different
character; the cut still happens at the same place.

**Fix.** Extended the existing leading-em-dash strip in
`TtsQueue.fetchTts` (which was already trimming chunks that begin
with `—`) to also strip leading whitespace + quote-like characters
of every flavor: straight `"` and `'`, curly `“ ” ‘ ’`, and the
guillemets `« »` (still listed for defensive completeness even
though the prompt no longer asks for them).

```ts
.replace(/^[-\s—–"'“”‘’«»]+/, "")
```

The natural pause between TTS chunks already provides the
separation that the leading mark was visually conveying. The chat
bubble still shows the leading quote — only the audio is cleaned.

**Takeaway.** "The character works fine in the middle" does not
imply "the character works fine at the start of a chunk". TTS
engines weight punctuation by context, and a punctuation character
with no preceding content can produce artefacts a downstream user
attributes to mispronunciation. When you're streaming audio split
on sentence boundaries, any *delimiter character* that can land on
a boundary needs to be stripped from the chunk start.

**Follow-up: generalize from enumeration to class.** The fix above
enumerated specific character families (guillemets, straight quotes,
curly quotes, dashes). The next reasonable question — and the user
asked it — is "what about every other special character?". Each
new symptom would otherwise mean adding one more character to the
list. The cleaner formulation is **strip any leading character
that isn't a letter or a digit**, using Unicode property escapes:

```ts
.replace(/^[^\p{L}\p{N}]+/u, "")
```

`\p{L}` matches any Unicode letter (so accented Italian / French /
Russian etc. characters are preserved); `\p{N}` matches any digit
(so chunks starting with `5. Quinto…` keep their numbering). The
negated class `[^…]` then catches *any* other leading character —
quotes, dashes, bullets, parens, brackets, math symbols, emoji,
anything that lands on a sentence boundary as a delimiter. One rule
replaces the running list and is future-proof against new symptom
characters.

This **does not** generalize to mid-text. Mid-text punctuation is
load-bearing — commas drive pauses, em-dashes drive breaks,
apostrophes are required for contractions (`l'esempio`,
`qu'est-ce`), inside-text quotes carry intonation cues. Stripping
those would flatten the audio into a run-together monotone. The
problem we're solving is specifically the *boundary* — punctuation
without preceding context — not "punctuation is bad". Keep the
chunk-start strip aggressive and the mid-text policy minimal
(currently just the legacy guillemet backup from §13.10's v3.7
change, defensive for users with old saved prompts).

**Meta-principle.** When you find yourself patching the same
category of issue with a slightly different character each time,
look for the class. There's usually a property — "leading non-
alphanumeric", "starts on a delimiter", "outside the letter set" —
that captures the pattern. Replacing enumeration with class is
worth doing the moment the enumeration starts to look like
whack-a-mole.

**Second follow-up: the trailing edge is symmetric.** A later
report described "the second sentence breaks" on this Italian
response:

```
"Io faccio tutto bene." — Il verbo "fare" deve essere coniugato
correttamente. "Faccio" è la forma giusta per la prima persona
singolare.
```

Tracing the splitter showed the chunks were:

1. `"Io faccio tutto bene." —`
2. `Il verbo "fare" deve essere coniugato correttamente.`
3. `"Faccio" è la forma giusta per la prima persona singolare.`

The leading strip handled chunk 3's leading `"` correctly — but
chunk 1 *ends* with `." —`. tts-1 tries to interpret the dangling
punctuation prosodically with no following content, produces a
choppy ending, and the choppy end smears into the inter-chunk
pause. The listener attributes the artefact to the start of the
next chunk and reports "the second sentence is broken" — when
actually it's the *first* chunk ending badly that ruined the
boundary.

Added the symmetric trailing strip:

```ts
.replace(/[^\p{L}\p{N}.?!…]+$/u, "")
```

Same Unicode property-class trick, but on the trailing edge.
**Terminal punctuation** (`.?!…`) is preserved because tts-1 needs
it to land the sentence-ending intonation; *other* trailing
non-alphanumeric (em-dashes, closing quotes, commas, etc.) is
stripped. With both edges cleaned, chunks reach tts-1 looking
like complete, well-terminated sentences regardless of how the
streaming splitter happened to cut them.

**The pattern.** Chunk-boundary characters are symmetric. If a
character class is bad at the *start* of a chunk, the same class
is usually bad at the *end* — for the same reason (no surrounding
context to interpret prosodically). When you strip leading
delimiters, the trailing version is a mirror question. Solve both
at the same time.

### 13.12  The "long pause" was MediaSource never finalizing

**Symptom.** User reported "a long pause after the first sentence"
in multi-sentence responses, even after the v3.11 trailing-strip
fix. The audio for sentence 1 would play through, then a multi-
second silence, then sentence 2 would eventually start.

**Initial assumption.** Inter-sentence buffer latency — sentence 2's
fetch hadn't finished priming its 600 ms buffer by the time
sentence 1's audio ended, so `playNext` was blocked awaiting the
audio promise. The user nudged "investigate thoroughly" and that
turned out to be wrong.

**Root cause.** In `TtsQueue.fetchTts`'s streaming pump:

```ts
if (done) {
  if (mediaSource.readyState === "open") {
    try {
      mediaSource.endOfStream();      // ← can throw InvalidStateError
    } catch {
      /* ignore */                     // ← silent failure
    }
  }
  // ...
}
```

The bug chain:

1. Pump appends the last chunk via `appendBuffer(value)`. Succeeds.
2. SourceBuffer enters `updating: true` state (the append is
   asynchronous internally — the SourceBuffer takes a tick to
   process).
3. Loop iterates. `reader.read()` returns `{ done: true }`.
4. We enter the `done` branch and immediately call
   `mediaSource.endOfStream()`.
5. **But `sourceBuffer.updating` is still `true` from step 2.**
   `endOfStream()` throws `InvalidStateError` whenever any
   SourceBuffer attached to the MediaSource is still updating.
6. The throw lands in the `catch { /* ignore */ }`. Silent failure.
7. MediaSource never transitions to `"ended"`. It stays `"open"`.
8. The audio element's `duration` stays at `+Infinity` (or is
   never finalized to the buffered length).
9. After audio plays through the buffered range, `currentTime`
   cannot equal `duration` (which is Infinity), so the
   `ended` event never fires.
10. `playNext` is awaiting a Promise that resolves on `audio.onended`.
    It blocks until the browser's internal stall timeout (~30 s on
    Chrome) eventually fires `audio.onerror`, which lets the
    `catch` block move `playNext` to the next item.

The user heard this as a multi-second silence after each sentence
— not because the *next* sentence's buffer wasn't ready, but
because the *previous* sentence's audio element was hanging in its
post-playback `waiting` state.

**Fix.** Extracted a `finalizeStream()` helper that **awaits any
in-flight SourceBuffer update before calling `endOfStream()`**, and
upgraded the silent catch to a `console.warn` so similar failures
become visible in dev:

```ts
const finalizeStream = async () => {
  if (mediaSource.readyState !== "open") return;
  if (sourceBuffer.updating) {
    await new Promise<void>((resolve) =>
      sourceBuffer.addEventListener("updateend", () => resolve(), { once: true }),
    );
  }
  if (mediaSource.readyState !== "open") return;
  try {
    mediaSource.endOfStream();
  } catch (e) {
    console.warn("MediaSource endOfStream failed:", e);
  }
};
```

Used in both the happy path (after `reader.read()` returns done)
and the error catch handler at the end of the pump.

**Takeaway.** Two for the blog post:

1. **MediaSource lifecycle has a serial dependency on SourceBuffer
   state** that isn't obvious from the API surface. Both the
   `appendBuffer` → `updateend` cycle and the `endOfStream` → `ended`
   transition need clean state. Calling them in the wrong order
   doesn't return an error code — it throws `InvalidStateError`
   that's easy to swallow and impossible to detect downstream
   because the symptom is "nothing happens, eventually". When an
   asynchronous API has a "wait for the last operation to finish
   before starting the next" pattern, encode it as a helper, not
   as a hope.
2. **"Silent catch" is a debugging mine.** The pattern
   `try { … } catch { /* ignore */ }` looks like belt-and-braces but
   can hide load-bearing failures. When the failure mode is
   "nothing happens" rather than "something crashes", a swallowed
   exception is invisible. `console.warn` at minimum, even for
   conditions you expect to never trigger — they sometimes do.

The inter-sentence buffer-latency hypothesis was also wrong because
of how `audioPromise` resolution interacts with `playNext`: sentence
2's `fetchTts` is started when the LLM stream emits sentence 2's
boundary, which happens well before sentence 1's audio finishes
playing. By the time `playNext` recurses to sentence 2, the
audio promise has been resolved for seconds. The real lag was on
the *outgoing* edge of sentence 1, not the *incoming* edge of
sentence 2.

---

## 14. System-Level Alternatives Considered & Rejected

These are whole-architecture alternatives that were evaluated against
the current stack and dismissed.

### 14.1  OpenAI Realtime API (voice-native pipeline)

**What it is.** Single API call carrying audio in and audio out,
collapsing STT → LLM → TTS into one WebSocket session with very low
end-to-end latency (~300–500 ms).

**Why rejected.** Cost. The Realtime API runs ~$70–$100/month at
moderate daily use — roughly **20–30× more expensive** than the current
stack (~$2–$4/month). The latency win is real but doesn't justify the
multiplier for a personal-use tool.

Worth revisiting if Realtime pricing drops materially, or if the
project's user base shifts to one where latency is more valuable than
cost.

### 14.2  Local models (Ollama, llama.cpp, etc.)

**What it is.** Run the LLM (and optionally STT/TTS) locally on the
user's device. Zero per-turn cost, fully private.

**Why rejected.** Grammar correction quality for multilingual use cases
requires large models, which require meaningful GPU hardware on the
client. Asking every user of an open-source tool to provision a local
inference stack is unreasonable. Smaller local models hit the same
quality wall that pushed us off Llama 3.3 70B on Groq.

### 14.3  Backend server

**What it would buy.** Server-side encrypted key storage (genuinely
safer than client-only encryption), centralized logging, server-side
rate limiting, the option to proxy through a single OpenAI/Groq account.

**Why rejected.** Adds hosting cost, deployment surface, and maintenance
burden for what was scoped as a zero-infrastructure open-source project.
The client-only constraint is a feature, not a limitation — anyone can
clone and deploy without provisioning anything.

---

## 15. File Map

| File | Role |
|---|---|
| `src/lib/prompt-store.ts` | Single source of truth for prompt structure. Exports `buildBaseSystemPrompt`, `buildLanguageSection`, `buildKbAddendum`, `composeFinalPrompt`, `stripKbSections`, `replaceLanguageInPrompt`, `replaceLevelInPrompt`, plus IndexedDB helpers and level/language utilities. Owns the dynamic-vs-editable section separation (§6.7). |
| `src/lib/groq-stream.ts` | Streaming wrapper around the OpenAI chat-completions endpoint (despite the name — actual API call goes to `api.openai.com`). Implements sentence-boundary detection, including the first-chunk-flush optimization. The Groq endpoint is used for STT only. |
| `src/lib/tts-queue.ts` | Sentence-level TTS queue with MediaSource-streamed playback. Strips French guillemets («/») before sending text to TTS (§13.4). Mirrors MP3 chunks into a per-sentence cache via `onAudioReady` so the replay button can play without a new TTS request (§7.8). Falls back to fully-buffered Blob playback where MSE/MP3 isn't supported. |
| `src/lib/conversation-state.ts` | Shared in-memory chat history (UI message list + LLM context array). Pulled out of `index.tsx` so settings.tsx can call `clearConversation()` when the language switches (§13.6). |
| `src/lib/language-config.ts` | Language registry (codes, labels, STT codes, prompt names, beta flags). Reads `fvt_kb` / `fvt_config` for effective language with priority: settings → KB → default. Contains a vestigial `personaPrompt` field not currently consumed at runtime. |
| `src/lib/app-state.tsx` | `ChatMessage` type and minor cross-cutting helpers. |
| `src/routes/__root.tsx` | Root layout, theme provider, head tags (including preconnects to OpenAI / Groq). Defines the sticky `TopNav` (Practice / Guide / Settings tabs with theme toggle on the left edge and GitHub icon on the right edge), the `useTheme` hook, and the footer with the Contact / "Buy me a coffee" links. |
| `src/routes/index.tsx` | The chat surface. Owns the mic → STT → chat → TTS orchestration. Holds the per-message audio cache for the replay button (§7.8) and the language-defensive composition via `composeFinalPrompt`. |
| `src/routes/settings.tsx` | Config + KB + custom-prompt editor. `Save Settings` persists config and the prompt together; the textarea preview re-prepends a fresh `LANGUAGE` section so the user sees what their prompt looks like at chat time. Owns "Clear All Data" and `applyLanguageChange` (which clears conversation history when language changes). |
| `src/routes/setup.tsx` | First-run wizard. UI in place; the encryption layer is a planned v2 enhancement (§10.3). |
| `src/routes/unlock.tsx` | Return-visit unlock screen. UI in place; the unlock layer is a planned v2 enhancement (§10.3). |
| `src/routes/instructions.tsx` | The Guide page. Parses `src/content/instructions.md` into title / intro / accordion sections and renders each section's body through `react-markdown` with component overrides matched to the existing styling (§11.5). |
| `src/content/instructions.md` | Source-of-truth prose for the Guide page. Editing this file changes the page text without any JSX edits. See §11.5 for the markdown conventions. |
| `src/components/MicButton.tsx` | The big mic button with hold-to-talk behaviour. |
| `src/components/HugoAvatar.tsx` | Speaking-state animated avatar. |
| `src/components/ChatBubble.tsx` | One chat message render. |

---

## 16. Data Flow — One Chat Turn

```
1. User presses mic
   └─ MediaRecorder starts with negotiated mimetype (webm/opus | mp4 | mpeg)

2. User releases mic
   └─ MediaRecorder stops → Blob assembled from chunks

3. STT request
   POST https://api.groq.com/openai/v1/audio/transcriptions
   model=whisper-large-v3, language=getEffectiveLanguage().sttCode
   ← transcript string

4. Push user message into:
   • messages (UI state, via persistedMessages module ref)
   • conversationRef (LLM history array)

5. Build system prompt
   ├─ loadCustomPrompt() from IndexedDB (fvt_prompt_db.prompts)
   │   └─ if absent → buildBaseSystemPrompt()
   └─ composeFinalPrompt(base):
       ├─ stripKbSections(base) [defensive]
       └─ buildKbAddendum() [reads fvt_kb + fvt_config]
       └─ insert addendum before CONVERSATION LEVEL section

6. Chat request (streaming)
   POST https://api.openai.com/v1/chat/completions
   model=gpt-4o-mini, stream=true
   body: { messages: [systemPrompt, ...conversation(≤16), newUserMsg] }

7. For each SSE token chunk:
   ├─ onToken → update assistant message UI
   └─ on sentence/first-chunk boundary →
       ttsQueue.enqueue(sentence)
       └─ TtsQueue.fetchTts(sentence):
           POST https://api.openai.com/v1/audio/speech
           model=tts-1, response_format=mp3
           ├─ create MediaSource + Audio element
           ├─ pump response.body chunks → sourceBuffer.appendBuffer
           ├─ return audio element (buffering in background)
           └─ TtsQueue.playNext picks it up in order
               └─ audio.play() — browser starts on first buffered frame

8. onDone:
   ├─ push assistant message into conversationRef
   ├─ if length > 16 → slice(-16) to trim
   └─ ttsQueue.finish() (drains, fires onDone)
```

Parallelism notes:

- **TTS overlaps LLM streaming.** First TTS request fires as soon as the
  first sentence boundary is detected, while later sentences are still
  being generated.
- **TTS overlaps TTS.** Multiple sentences can be in-flight at the OpenAI
  TTS endpoint simultaneously; the queue plays them in order regardless.
- **MediaSource streaming overlaps download.** The first audio frame plays
  while later frames are still arriving over the wire.

---

## 17. Maintenance Notes

### Prompt edits

Two categories of section. Decide which before you start editing
(§6.7).

- **Adding a new editable section.** Add it inside
  `buildBaseSystemPrompt` (so the textarea preview shows it). **Don't**
  add its header to `DYNAMIC_SECTION_HEADERS` — that list is for
  data-driven sections that get stripped at chat time. The new section
  will be saved verbatim in IndexedDB and preserved across chat turns.
  If `composeFinalPrompt` needs to position the KB addendum relative
  to it, update that logic.
- **Adding a new dynamic section.** Add its header to
  `DYNAMIC_SECTION_HEADERS`. Write a `buildXSection()` helper in
  `prompt-store.ts` that produces the section from whatever source of
  truth (settings, KB, etc.). Wire it into `composeFinalPrompt` and
  `buildBaseSystemPrompt` at the right composition position. Add a
  fresh-prepend in the settings page's mount logic if the user should
  see it in the textarea preview.
- **Adding a new KB field.** Read it inside `buildKbAddendum` from
  `localStorage.getItem("fvt_kb")`. Apply `sanitizeKbString` to any
  string content. Cap any array content with a `slice(0, MAX_*)`.
- **Changing section ordering.** Update `composeFinalPrompt`'s
  insertion logic (which currently anchors `LANGUAGE` after `ROLE`
  and the KB addendum before `CONVERSATION LEVEL`). Re-derive the
  prefix-cache reasoning from §6.2 for any new section.
- **Prose changes that include section header strings.** Update
  string constants in `prompt-store.ts` (e.g. `ROLE_HEADER`,
  `LANGUAGE_HEADER`) — never grep for prose. Anchors on prose were
  the original v2.x mistake (§13.2, §13.6).

### History cap

One constant, two adjacent lines in `src/routes/index.tsx`
(`> 16` and `slice(-16)`). Keep them in sync.

### Audio pipeline edits

- **Changing the TTS model.** Update `model: "tts-1"` inside
  `TtsQueue.fetchTts`. If switching to a model that emits a different
  audio format, also update `response_format` and the `addSourceBuffer`
  MIME type (currently `audio/mpeg`).
- **Adjusting first-chunk threshold.** `MIN_FIRST_CHUNK_CHARS` and
  `FIRST_CHUNK_BOUNDARY` at the top of `src/lib/groq-stream.ts`.
- **Adding a new API endpoint.** Add its origin to the preconnect list
  in `src/routes/__root.tsx`.

### Storage additions

If you add any new persisted state, update the "Clear All Data" handler
in `src/routes/settings.tsx` so the reset path remains complete.

### Editing the Guide page

The Guide content lives in `src/content/instructions.md`. Edit the
markdown directly; no JSX changes required. Conventions:

- One `# H1` at the top — the page title (only one).
- A paragraph immediately under the H1 becomes the page subtitle.
- Each `## H2` becomes one accordion section. Order in the file is
  order on the page. To add a new section, add a new `## …` block.
- Inside a section: `**bold**`, `[text](url)` (external links open
  in a new tab automatically), `1.` / `-` lists, `> 💡 …` for
  highlighted tip-box callouts.
- After editing, run `npm run build` (or restart the dev server) to
  pick up the new content — Vite inlines the markdown at build time
  via the `?raw` import in `src/routes/instructions.tsx`.

See §11.5 for the rationale and full mechanism.

### Adding a language

Add an entry to `LANGUAGES` in `src/lib/language-config.ts` with the
`sttCode`, `promptLang`, and `ttsLang` set. Mark `beta: true` until LLM
grammar-correction reliability is verified on a held-out sample.

### Known cleanup items

`LanguageConfig.personaPrompt` and `LanguageConfig.correctionIntro` are
populated for every language but not read at runtime.
