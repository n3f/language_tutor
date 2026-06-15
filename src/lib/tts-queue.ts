/**
 * OpenAI TTS with queued, gap-free playback.
 *
 * Pipeline: callers `enqueue(text)` one sentence at a time as they fall out
 * of the LLM streaming response. Each enqueue immediately fires its own
 * `/audio/speech` request — fetches run in parallel — but a separate playback
 * loop (`playNext`) awaits each sentence's audio promise in enqueue order,
 * so the user hears the assistant's reply in the right sequence regardless
 * of which fetches resolve first.
 *
 * Two transport modes:
 *  - Streaming (preferred): where Media Source Extensions support audio/mpeg,
 *    MP3 bytes are piped into a MediaSource as they arrive so playback can
 *    start before the full response has downloaded. Cuts perceived latency
 *    on the first sentence dramatically.
 *  - Buffered fallback: browsers without MSE/MP3 support (mostly Safari
 *    historically) get a fully-downloaded Blob played via a regular Audio
 *    element.
 *
 * Sentence audio is also surfaced to `onAudioReady` so the orchestrator can
 * cache the MP3 blobs and replay them later without re-spending TTS quota
 * (see src/routes/index.tsx for the cache and replay logic).
 */

export interface TtsConfig {
  apiKey: string;
  voice?: string; // OpenAI voice: nova, onyx, alloy, etc.
  speed?: number; // 0.25 - 4.0
}

interface QueueItem {
  text: string;
  audioPromise: Promise<HTMLAudioElement | null>;
}

/** True when the runtime supports streaming MP3 via Media Source Extensions. */
function streamingSupported(): boolean {
  return (
    typeof MediaSource !== "undefined" &&
    typeof MediaSource.isTypeSupported === "function" &&
    MediaSource.isTypeSupported("audio/mpeg")
  );
}

export class TtsQueue {
  private config: TtsConfig;
  private queue: QueueItem[] = [];
  private playing = false;
  private aborted = false;
  private currentAudio: HTMLAudioElement | null = null;
  /** Fires `true` when the first sentence begins, `false` after the last drains.
   *  Used by the UI to drive the speaking-avatar animation. */
  public onSpeakingChange?: (speaking: boolean) => void;
  /** Fires at the moment each sentence's audio actually starts playing — the
   *  orchestrator uses this to scroll the chat bubble currently being read. */
  public onSentenceStart?: (text: string) => void;
  /** Fires once after `finish()` has been called AND the queue has fully drained.
   *  Signals the end of a complete assistant turn. */
  public onDone?: () => void;
  /** Fires once per sentence after its full MP3 has been downloaded. The
   * `index` is the enqueue position (0-based, monotonically increasing) so
   * the orchestrator can slot each blob in the right cache position even
   * though parallel fetches can resolve out of order. Replay then plays in
   * enqueue order, matching the original chat output. */
  public onAudioReady?: (text: string, blob: Blob, index: number) => void;
  /** True if any sentence's TTS fetch failed; tells the orchestrator the
   * audio cache is incomplete and replay must regenerate via TTS. */
  public hadError = false;
  /** Monotonic counter assigned at enqueue time. Each call to enqueue gets
   * the next index; passed to fetchTts and forwarded to onAudioReady so
   * the orchestrator can order blobs deterministically. */
  private enqueueCount = 0;
  private streamEnded = false;

  constructor(config: TtsConfig) {
    this.config = config;
  }

  /** Enqueue a sentence — starts TTS fetch immediately, plays in order */
  enqueue(text: string) {
    if (this.aborted) return;
    const index = this.enqueueCount++;
    const audioPromise = this.fetchTts(text, index).catch((err) => {
      console.error("TTS fetch error:", err);
      this.hadError = true;
      return null;
    });
    this.queue.push({ text, audioPromise });
    if (!this.playing) this.playNext();
  }

  /** Signal that no more sentences will come — queue will drain and fire done */
  finish() {
    this.streamEnded = true;
    if (!this.playing && this.queue.length === 0) {
      this.onSpeakingChange?.(false);
      this.onDone?.();
    }
  }

  abort() {
    this.aborted = true;
    this.queue = [];
    if (this.currentAudio) {
      this.currentAudio.pause();
      if (this.currentAudio.src) {
        try {
          URL.revokeObjectURL(this.currentAudio.src);
        } catch {
          /* ignore */
        }
      }
      this.currentAudio = null;
    }
    this.playing = false;
    this.onSpeakingChange?.(false);
  }

  private async fetchTts(text: string, index: number): Promise<HTMLAudioElement | null> {
    if (this.aborted) return null;

    // Pre-TTS text normalization. Four steps:
    //
    // 1) Defensive: strip French guillemets («/») globally. The default
    //    prompt uses straight " " since v3.7, but users with saved custom
    //    prompts may still have the model producing «» — and they cause
    //    audible glitches even in the middle of text (§13.4).
    //
    // 2) Strip leading non-letter / non-digit characters from the chunk.
    //    The streaming sentence-splitter (groq-stream.ts) cuts at sentence
    //    boundaries, so each chunk reaches tts-1 as a standalone request.
    //    Whenever the cut lands such that the next chunk begins with a
    //    delimiter character — quote, dash, paren, bullet, anything that
    //    isn't a letter or digit — tts-1 produces a brief lead-in artefact
    //    because the engine has no preceding context to interpret the
    //    leading mark prosodically.
    //
    // 3) Strip trailing characters that aren't letters, digits, or
    //    terminal punctuation (`.?!…`). Same problem in reverse: a chunk
    //    ending with delimiter characters like `." —` makes tts-1 try to
    //    interpret the dangling punctuation prosodically with no
    //    following content, producing a choppy ending that smears into
    //    the inter-chunk pause and sounds like the *next* chunk's start
    //    is broken. Terminal punctuation (period, question mark,
    //    exclamation, ellipsis) is preserved because it carries the
    //    sentence-ending intonation tts-1 needs.
    //
    //    Mid-text punctuation is NOT stripped — tts-1 uses it for prosody
    //    (commas for pauses, em-dashes for breaks, apostrophes for
    //    contractions like "l'esempio"), and inside-text quotes carry
    //    intonation cues. Only the chunk *edges* are the problem.
    //
    //    Uses Unicode property escapes (\p{L}, \p{N}) so accented Italian
    //    / French / Russian / etc. letters are preserved.
    //
    // 4) Collapse any whitespace runs the strips leave behind.
    const cleanedText = text
      .replace(/[«»]/g, "")
      .replace(/^[^\p{L}\p{N}]+/u, "")
      .replace(/[^\p{L}\p{N}.?!…]+$/u, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!cleanedText) return null;

    const voice = this.config.voice || "nova";
    const speed = this.config.speed ?? 1;

    const resp = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "tts-1",
        input: cleanedText,
        voice,
        speed,
        response_format: "mp3",
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`OpenAI TTS ${resp.status}: ${errText}`);
    }
    if (!resp.body) throw new Error("OpenAI TTS: no response body");
    if (this.aborted) {
      try {
        resp.body.cancel();
      } catch {
        /* ignore */
      }
      return null;
    }

    // Fallback path for browsers without MSE/MP3 support
    if (!streamingSupported()) {
      const buffer = await resp.arrayBuffer();
      if (this.aborted) return null;
      const blob = new Blob([buffer], { type: "audio/mpeg" });
      try {
        this.onAudioReady?.(text, blob, index);
      } catch (e) {
        console.error("onAudioReady callback error:", e);
      }
      const audio = new Audio(URL.createObjectURL(blob));
      return audio;
    }

    // Streaming path: pump MP3 chunks into a MediaSource as they arrive so
    // playback can start before the response is fully downloaded.
    const mediaSource = new MediaSource();
    const audio = new Audio();
    const objectUrl = URL.createObjectURL(mediaSource);
    audio.src = objectUrl;
    audio.preload = "auto";

    await new Promise<void>((resolve) => {
      if (mediaSource.readyState === "open") resolve();
      else mediaSource.addEventListener("sourceopen", () => resolve(), { once: true });
    });

    if (this.aborted) {
      URL.revokeObjectURL(objectUrl);
      try {
        resp.body.cancel();
      } catch {
        /* ignore */
      }
      return null;
    }

    const sourceBuffer = mediaSource.addSourceBuffer("audio/mpeg");
    const reader = resp.body.getReader();
    // Mirror every chunk into an array so we can build a Blob for the
    // replay cache once the stream finishes. .slice() copies the bytes
    // because the SourceBuffer's appendBuffer can drain them otherwise.
    const cacheChunks: Uint8Array[] = [];

    // Pump asynchronously — do NOT await here so the audio element can be
    // returned without holding the full download.
    (async () => {
      // Helper: signal MediaSource end-of-stream after any in-flight
      // SourceBuffer update finishes. Without this wait, endOfStream()
      // throws InvalidStateError, MediaSource stays in "open" state, the
      // audio's duration is never finalized, and `audio.onended` never
      // fires after playback catches up — which the user hears as a long
      // pause at the end of each sentence before the next one starts.
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
          // Log if endOfStream still fails so we'd notice in dev console.
          console.warn("MediaSource endOfStream failed:", e);
        }
      };
      try {
        while (!this.aborted) {
          const { done, value } = await reader.read();
          if (done) {
            await finalizeStream();
            if (!this.aborted && cacheChunks.length > 0) {
              try {
                const blob = new Blob(cacheChunks as BlobPart[], { type: "audio/mpeg" });
                this.onAudioReady?.(text, blob, index);
              } catch (e) {
                console.error("onAudioReady callback error:", e);
              }
            }
            return;
          }
          if (sourceBuffer.updating) {
            await new Promise<void>((resolve) =>
              sourceBuffer.addEventListener("updateend", () => resolve(), { once: true }),
            );
          }
          if (this.aborted) return;
          try {
            sourceBuffer.appendBuffer(value);
            cacheChunks.push(value.slice());
          } catch (e) {
            console.error("TTS appendBuffer error:", e);
            return;
          }
        }
      } catch (err) {
        if (!this.aborted) console.error("TTS streaming pump error:", err);
        // Same bug-class as the happy-path: even on error, signal
        // end-of-stream cleanly so the audio element's onended can fire
        // and playNext can advance.
        await finalizeStream();
      }
    })();

    // Wait for an explicit minimum of buffered audio AND the browser's own
    // readiness signal before returning. The v3.4 fix used a 300 ms buffer
    // threshold alone, but intermittent slow-arriving chunks could still let
    // `play()` start with marginal lead time, producing mangled audio at
    // the beginning of the response in some cases.
    //
    // The current design requires three things to be true:
    //   1. The buffered range has at least 600 ms of audio.
    //   2. `audio.readyState >= HAVE_FUTURE_DATA` — the browser also agrees
    //      it can play forward from the current position without stalling.
    //   3. A polling interval (50 ms) backs up the event listeners in case
    //      the `progress` event timing for MSE is uneven across browsers.
    //
    // Once these are satisfied, playback starts cleanly from the start of
    // the buffered range. Subsequent sentences in a warm session reach
    // these thresholds near-instantly, so no extra latency at steady state.
    const MIN_BUFFER_SECONDS = 0.6;
    await new Promise<void>((resolve) => {
      if (this.aborted) {
        resolve();
        return;
      }
      const ready = () =>
        audio.buffered.length > 0 &&
        audio.buffered.end(0) >= MIN_BUFFER_SECONDS &&
        audio.readyState >= 3; /* HAVE_FUTURE_DATA */
      const cleanup = () => {
        audio.removeEventListener("progress", check);
        audio.removeEventListener("canplay", check);
        audio.removeEventListener("canplaythrough", check);
        clearTimeout(timer);
        clearInterval(interval);
      };
      const check = () => {
        if (this.aborted || ready()) {
          cleanup();
          resolve();
        }
      };
      const timer = setTimeout(() => {
        cleanup();
        resolve();
      }, 2000);
      const interval = setInterval(check, 50);
      audio.addEventListener("progress", check);
      audio.addEventListener("canplay", check);
      audio.addEventListener("canplaythrough", check);
      check();
    });

    if (this.aborted) {
      try {
        URL.revokeObjectURL(objectUrl);
      } catch {
        /* ignore */
      }
      return null;
    }

    // Defensive: seek to the actual start of the buffered range, not blindly
    // to 0. If the MP3 stream's first frame doesn't begin at t=0 (some
    // encoder padding or decoder-delay accounting), setting currentTime to
    // a non-buffered position can cause the browser to snap forward into
    // audible content, which sounds like a clipped start. Seeking to
    // buffered.start(0) lands us at the actual first sample.
    try {
      if (audio.buffered.length > 0) {
        audio.currentTime = audio.buffered.start(0);
      }
    } catch {
      /* ignore — some browsers refuse if no data is loaded; that's fine */
    }

    return audio;
  }

  private async playNext() {
    if (this.aborted) return;
    const item = this.queue.shift();
    if (!item) {
      this.playing = false;
      if (this.streamEnded) {
        this.onSpeakingChange?.(false);
        this.onDone?.();
      }
      return;
    }

    this.playing = true;
    this.onSpeakingChange?.(true);

    try {
      const audio = await item.audioPromise;
      if (!audio || this.aborted) {
        if (audio?.src) {
          try {
            URL.revokeObjectURL(audio.src);
          } catch {
            /* ignore */
          }
        }
        this.playNext();
        return;
      }

      this.onSentenceStart?.(item.text);
      this.currentAudio = audio;

      await new Promise<void>((resolve, reject) => {
        audio.onended = () => resolve();
        audio.onerror = () => reject(new Error("Audio playback error"));
        audio.play().catch(reject);
      });

      if (audio.src) {
        try {
          URL.revokeObjectURL(audio.src);
        } catch {
          /* ignore */
        }
      }
      this.currentAudio = null;
    } catch (err) {
      console.error("TTS playback error:", err);
      this.currentAudio = null;
    }

    this.playNext();
  }
}
