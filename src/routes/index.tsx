/**
 * Practice page — the main voice-conversation surface.
 *
 * Per-turn pipeline when the user presses-and-releases the mic:
 *   1. MediaRecorder captures audio into Blob chunks.
 *   2. The Blob is POSTed to Groq Whisper for transcription (STT).
 *   3. The transcript becomes a `user` message; we append it to the running
 *      conversation array.
 *   4. We stream a chat completion from OpenAI (via `streamGroqChat`), which
 *      emits sentence-level chunks via `onSentence`.
 *   5. Each sentence is immediately enqueued onto a `TtsQueue` that fetches
 *      MP3 audio in parallel but plays in enqueue order. The first sentence
 *      starts playing before later sentences have even left the LLM.
 *   6. As each sentence's full MP3 arrives, `onAudioReady` slots it into
 *      `audioCacheRef` so the user can replay the message later without
 *      spending another TTS round-trip (see `handleReplay`).
 *
 * State that survives navigation lives in module-level stores
 * (`@/lib/conversation-state`, `@/lib/prompt-store`) rather than React state,
 * so the user can switch to Settings and back without losing chat history
 * or the in-flight conversation.
 */
import { createFileRoute } from "@tanstack/react-router";
import { useRef, useEffect, useCallback, useState, useMemo } from "react";
import { toast } from "sonner";
import { Trash2 } from "lucide-react";
import { HugoAvatar } from "@/components/HugoAvatar";
import { MicButton } from "@/components/MicButton";
import { ChatBubble } from "@/components/ChatBubble";
import type { ChatMessage } from "@/lib/app-state";
import { streamGroqChat, type GroqMessage } from "@/lib/groq-stream";
import { TtsQueue } from "@/lib/tts-queue";
import { getEffectiveLanguage } from "@/lib/language-config";
import { buildBaseSystemPrompt, composeFinalPrompt, loadCustomPrompt } from "@/lib/prompt-store";
import {
  clearConversation,
  getPersistedConversation,
  getPersistedMessages,
  setPersistedConversation,
  setPersistedMessages,
  subscribeMessages,
  updatePersistedMessages,
} from "@/lib/conversation-state";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "AI-powered Language Practice Through Conversation" },
      { name: "description", content: "Language speaking practice with an AI tutor" },
    ],
  }),
  component: Index,
});

/** True when the page is rendered inside an iframe (e.g. a hosting preview).
 *  Browsers block microphone capture in cross-origin iframes — we detect this
 *  and pop the practice page out into a standalone tab instead. */
function isEmbeddedPreview() {
  return window.self !== window.top;
}

/** Compose the system prompt sent on every chat turn. Reads the
 *  user-editable saved prompt (or the default if none) and lets
 *  `composeFinalPrompt` strip data-derived sections and rebuild them fresh
 *  from current settings — so a stale dropdown setting or KB edit can never
 *  leak into a turn. */
async function buildSystemPrompt(): Promise<string> {
  let base = "";
  try {
    const custom = await loadCustomPrompt();
    if (custom) base = custom;
  } catch {}
  if (!base) base = buildBaseSystemPrompt();
  return composeFinalPrompt(base);
}

function Index() {
  // Local React state mirror of the persisted store. The store is the source
  // of truth (lives at module scope so navigation doesn't blow it away); this
  // copy just drives re-renders.
  const [messages, setMessagesLocal] = useState<ChatMessage[]>(getPersistedMessages());
  const [isRecording, setIsRecording] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const ttsQueueRef = useRef<TtsQueue | null>(null);
  const conversationRef = useRef<GroqMessage[]>([]);
  /** Cached per-sentence MP3 blobs for the most recent assistant message, so
   * the replay button can re-play without burning another TTS round-trip.
   * Only the latest assistant message is cached (it's the only one that gets
   * a replay button). `complete` flips true once the original turn's TTS
   * queue has fully drained without errors. */
  const audioCacheRef = useRef<{
    messageId: string;
    blobs: Blob[];
    complete: boolean;
  } | null>(null);
  /** AbortController for an in-flight cached-audio replay (separate from
   * ttsQueueRef because replay-from-cache bypasses the TTS queue). */
  const replayAbortRef = useRef<AbortController | null>(null);

  // Sync with the shared (module-level) persisted state. This is what makes
  // chat history survive navigation away from / back to the practice page
  // without re-fetching anything. settings.tsx mutates the same store when
  // language changes (to clear stale-language history) — the subscribe
  // listener below picks that up if the user is on this page.
  useEffect(() => {
    conversationRef.current = getPersistedConversation();
    setMessagesLocal(getPersistedMessages());
    const unsubscribe = subscribeMessages((msgs) => {
      setMessagesLocal(msgs);
      conversationRef.current = getPersistedConversation();
    });
    return unsubscribe;
  }, []);

  const setMessages = useCallback(
    (updater: ChatMessage[] | ((prev: ChatMessage[]) => ChatMessage[])) => {
      if (typeof updater === "function") {
        updatePersistedMessages(updater);
      } else {
        setPersistedMessages(updater);
      }
    },
    [],
  );

  const handleRecordStopRef = useRef<() => void>(() => {});

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const addMessage = useCallback((msg: Omit<ChatMessage, "id" | "timestamp">) => {
    updatePersistedMessages((prev) => [
      ...prev,
      { ...msg, id: crypto.randomUUID(), timestamp: new Date() },
    ]);
  }, []);

  /** Read config from localStorage (set by setup/settings screens) */
  const getConfig = useCallback(() => {
    try {
      const raw = localStorage.getItem("fvt_config");
      if (raw)
        return JSON.parse(raw) as {
          groqApiKey?: string;
          openaiApiKey?: string;
          ttsVoice?: string;
          ttsSpeed?: string;
        };
    } catch {
      /* ignore */
    }
    return null;
  }, []);

  const handleRecordStart = useCallback(async () => {
    audioChunksRef.current = [];

    if (!navigator.mediaDevices?.getUserMedia) {
      toast.error("Microphone recording is not supported in this browser.");
      return;
    }

    // Pre-check permission status (not supported in Safari)
    try {
      if (navigator.permissions) {
        const status = await navigator.permissions.query({
          name: "microphone" as PermissionName,
        });
        if (status.state === "denied") {
          toast.error(
            'Microphone is blocked for this site. Click the lock/site-settings icon in the address bar, set Microphone to "Allow", then reload the page.',
            { duration: 8000 },
          );
          return;
        }
      }
    } catch {
      // Safari doesn't support permissions.query for microphone — continue
    }

    // If embedded in an iframe, open in a standalone tab
    if (isEmbeddedPreview()) {
      window.open(window.location.href, "_blank", "noopener,noreferrer");
      toast.message("Opening voice mode in a new tab", {
        description: "Browsers block microphone capture inside embedded previews. Use the new tab.",
        duration: 6000,
      });
      return;
    }

    let stream: MediaStream | null = null;

    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      console.error("Mic permission error:", err);
      const name = err instanceof DOMException ? err.name : "";
      const message =
        name === "NotAllowedError"
          ? 'Microphone permission denied. Click the lock icon (\uD83D\uDD12) in the address bar \u2192 set Microphone to "Allow" \u2192 reload the page.'
          : name === "NotFoundError"
            ? "No microphone was found by the browser for this app tab."
            : name === "NotReadableError"
              ? "Your microphone is already in use by another app."
              : "Could not access microphone. Please allow mic permission and try again.";
      toast.error(message, { duration: 8000 });
      return;
    }

    try {
      const mimeType = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/mpeg"].find(
        (type) => MediaRecorder.isTypeSupported(type),
      );

      const mr = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);

      mediaRecorderRef.current = mr;
      mr.onstart = () => {
        setIsRecording(true);
      };
      mr.onerror = (event) => {
        console.error("MediaRecorder error:", event.error);
        toast.error("Recording failed. Please try again.");
        setIsRecording(false);
      };
      mr.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data);
      };
      mr.start(250); // collect in 250ms chunks
    } catch (err) {
      console.error("Recorder setup error:", err);
      stream.getTracks().forEach((track) => track.stop());
      mediaRecorderRef.current = null;
      setIsRecording(false);
      toast.error("Your browser allowed the mic, but could not start recording.");
    }
  }, []);

  const handleRecordStop = useCallback(async () => {
    setIsRecording(false);

    const mr = mediaRecorderRef.current;
    if (!mr || mr.state === "inactive") {
      setIsProcessing(false);
      return;
    }

    setIsProcessing(true);

    // Stop recording and wait for final data
    const audioBlob = await new Promise<Blob>((resolve) => {
      mr.onstop = () => {
        const blob = new Blob(audioChunksRef.current, { type: mr.mimeType });
        // Stop all tracks
        mr.stream.getTracks().forEach((t) => t.stop());
        resolve(blob);
      };
      mr.stop();
    });

    const config = getConfig();
    if (!config?.groqApiKey) {
      // Fallback: simulate if no API keys configured
      addMessage({ role: "user", content: "(No Groq API key — configure in Settings)" });
      setIsProcessing(false);
      return;
    }

    // 1. STT via Groq Whisper
    try {
      const formData = new FormData();
      formData.append("file", audioBlob, "audio.webm");
      formData.append("model", "whisper-large-v3");
      formData.append("language", getEffectiveLanguage().sttCode);

      const sttResp = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
        method: "POST",
        headers: { Authorization: `Bearer ${config.groqApiKey}` },
        body: formData,
      });

      if (!sttResp.ok) throw new Error(`STT ${sttResp.status}`);
      const sttData = await sttResp.json();
      const transcript = sttData.text?.trim();
      if (!transcript) {
        setIsProcessing(false);
        return;
      }

      addMessage({ role: "user", content: transcript });
      conversationRef.current.push({ role: "user", content: transcript });
      setPersistedConversation([...conversationRef.current]);

      // 2. Stream LLM response with sentence-level TTS
      const abort = new AbortController();
      abortRef.current = abort;

      // Create assistant message placeholder
      const assistantId = crypto.randomUUID();
      setMessages((prev) => [
        ...prev,
        { id: assistantId, role: "assistant", content: "", timestamp: new Date() },
      ]);

      // Abort any prior playback (TTS queue from previous turn, or a cached
      // replay) so this turn starts cleanly without overlapping audio.
      ttsQueueRef.current?.abort();
      replayAbortRef.current?.abort();

      // Open a fresh audio cache for this assistant message. Populated by
      // ttsQueue.onAudioReady as each sentence's MP3 finishes downloading;
      // flipped to complete=true in ttsQueue.onDone if the queue drains
      // without errors. The replay button reads from this on click.
      audioCacheRef.current = { messageId: assistantId, blobs: [], complete: false };

      // Set up TTS queue if OpenAI key available
      let ttsQueue: TtsQueue | null = null;
      if (config.openaiApiKey) {
        ttsQueue = new TtsQueue({
          apiKey: config.openaiApiKey,
          voice: config.ttsVoice || "nova",
          speed: config.ttsSpeed ? parseFloat(config.ttsSpeed) : 1,
        });
        ttsQueue.onSpeakingChange = (s) => setIsSpeaking(s);
        ttsQueue.onAudioReady = (_text, blob, index) => {
          // Slot the blob at its enqueue index so the cache stays in
          // sentence order even when parallel TTS fetches resolve out of
          // order (a shorter sentence's MP3 can finish downloading before
          // a longer earlier one). Without this, replay played sentences
          // in arrival order, which looked random to the user.
          if (audioCacheRef.current?.messageId === assistantId) {
            audioCacheRef.current.blobs[index] = blob;
          }
        };
        ttsQueue.onDone = () => {
          setIsSpeaking(false);
          // All sentences fetched + played without errors → cache is now
          // safe to replay from. Errored fetches leave hadError=true and
          // we'd serve gaps if we played from cache; fall back to TTS in
          // that case.
          if (audioCacheRef.current?.messageId === assistantId && ttsQueue && !ttsQueue.hadError) {
            audioCacheRef.current.complete = true;
          }
        };
        ttsQueueRef.current = ttsQueue;
      }

      setIsProcessing(false);

      const systemPrompt: GroqMessage = {
        role: "system",
        content: await buildSystemPrompt(),
      };

      await streamGroqChat({
        apiKey: config.openaiApiKey || "",
        messages: [systemPrompt, ...conversationRef.current],
        onSentence: (sentence) => {
          ttsQueue?.enqueue(sentence);
        },
        onToken: (fullText) => {
          setMessages((prev) =>
            prev.map((m) => (m.id === assistantId ? { ...m, content: fullText } : m)),
          );
        },
        onDone: (fullText) => {
          conversationRef.current.push({ role: "assistant", content: fullText });
          // Trim conversation to last 8 exchanges to bound input tokens per turn
          if (conversationRef.current.length > 16) {
            conversationRef.current = conversationRef.current.slice(-16);
          }
          setPersistedConversation([...conversationRef.current]);
          ttsQueue?.finish();
          if (!ttsQueue) setIsProcessing(false);
        },
        onError: (err) => {
          console.error("LLM stream error:", err);
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId ? { ...m, content: `Error: ${err.message}` } : m,
            ),
          );
          setIsProcessing(false);
        },
        signal: abort.signal,
      });
    } catch (err) {
      console.error("Conversation error:", err);
      setIsProcessing(false);
    }
  }, [addMessage, getConfig]);

  // Keep ref in sync
  useEffect(() => {
    handleRecordStopRef.current = handleRecordStop;
  }, [handleRecordStop]);

  const handleNewSession = useCallback(() => {
    clearConversation();
    conversationRef.current = [];
    abortRef.current?.abort();
    ttsQueueRef.current?.abort();
    replayAbortRef.current?.abort();
    audioCacheRef.current = null;
  }, []);

  /** Play the cached per-sentence MP3 blobs back-to-back. No network. */
  const playCachedAudio = useCallback(async (blobs: Blob[]) => {
    ttsQueueRef.current?.abort();
    replayAbortRef.current?.abort();
    const controller = new AbortController();
    replayAbortRef.current = controller;

    setIsSpeaking(true);
    try {
      for (const blob of blobs) {
        if (controller.signal.aborted) break;
        // Defensive: cache may be sparse if a fetch errored (hadError would
        // normally keep .complete=false and we'd skip this path, but if a
        // future change ever plays a partial cache, skip holes gracefully).
        if (!blob) continue;
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        try {
          await new Promise<void>((resolve, reject) => {
            audio.onended = () => resolve();
            audio.onerror = () => reject(new Error("Cached audio playback error"));
            controller.signal.addEventListener("abort", () => {
              audio.pause();
              resolve();
            });
            audio.play().catch(reject);
          });
        } catch (e) {
          console.error("Cached audio playback failed:", e);
        }
        URL.revokeObjectURL(url);
      }
    } finally {
      setIsSpeaking(false);
    }
  }, []);

  /** Replay an assistant message. Uses the cached blobs from the original
   * chat turn when available (zero network cost, identical intonation);
   * falls back to a fresh TTS request only if the cache is missing or
   * incomplete (e.g., after a page reload, or if some sentence's original
   * fetch errored). Aborts any in-flight playback before starting. */
  const handleReplay = useCallback(
    (messageId: string, text: string) => {
      const cache = audioCacheRef.current;
      if (cache && cache.messageId === messageId && cache.complete && cache.blobs.length > 0) {
        void playCachedAudio(cache.blobs);
        return;
      }

      // Cache miss → regenerate via TTS (costs another API call)
      const config = getConfig();
      if (!config?.openaiApiKey) {
        toast.error("Configure your OpenAI API key in Settings to enable replay.");
        return;
      }
      ttsQueueRef.current?.abort();
      replayAbortRef.current?.abort();
      const replayQueue = new TtsQueue({
        apiKey: config.openaiApiKey,
        voice: (config.ttsVoice as "nova" | "onyx") || "nova",
        speed: config.ttsSpeed ? parseFloat(config.ttsSpeed) : 1,
      });
      replayQueue.onSpeakingChange = (s) => setIsSpeaking(s);
      replayQueue.onDone = () => setIsSpeaking(false);
      ttsQueueRef.current = replayQueue;
      replayQueue.enqueue(text);
      replayQueue.finish();
    },
    [getConfig, playCachedAudio],
  );

  /** ID of the most recent assistant message with non-empty content. The
   * replay button only renders on this one bubble, to keep older messages
   * visually clean. */
  const latestAssistantId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === "assistant" && m.content.trim().length > 0) return m.id;
    }
    return null;
  }, [messages]);

  return (
    <div className="flex min-h-[calc(100dvh-8rem)] flex-col items-center bg-background">
      {/* Chat area */}
      <div ref={scrollRef} className="w-full px-4 py-2">
        {messages.length === 0 ? (
          <div
            className="flex flex-col items-center text-center"
            style={{ gap: 0, paddingTop: "20px", fontFamily: "Inter, sans-serif" }}
          >
            <div style={{ marginBottom: "40px", flexShrink: 0 }}>
              <HugoAvatar isSpeaking={isSpeaking} size={140} showBranding={true} />
            </div>
            <p
              className="text-foreground"
              style={{
                fontFamily: "Inter, sans-serif",
                fontSize: "18px",
                letterSpacing: "0.12em",
                fontWeight: 700,
                textAlign: "center",
                margin: "0 0 8px 0",
                textTransform: "uppercase",
              }}
            >
              AI-powered Language Practice Through Conversation
            </p>
            <p
              className="text-foreground"
              style={{
                fontFamily: "Inter, sans-serif",
                fontSize: "14px",
                textAlign: "center",
                maxWidth: "420px",
                lineHeight: 1.7,
                margin: "0 0 24px 0",
              }}
            >
              An open-source AI conversation partner for language learners. Speak freely, get
              corrected naturally, and practice exactly what you need — guided by your personal
              learning profile.
            </p>
            <div
              className="border border-border bg-primary/15"
              style={{
                margin: "0 auto",
                padding: "16px 20px",
                borderRadius: "8px",
                maxWidth: "460px",
              }}
            >
              <p
                className="text-foreground"
                style={{
                  fontFamily: "Inter, sans-serif",
                  fontSize: "14px",
                  textAlign: "center",
                  lineHeight: 1.6,
                  margin: 0,
                }}
              >
                Check the <strong>Guide</strong> for setup instructions, configure your{" "}
                <strong>Settings</strong>, and then come back to this page to begin.
              </p>
            </div>
          </div>
        ) : (
          <div className="mx-auto flex w-full max-w-lg flex-col gap-3 lg:max-w-3xl xl:max-w-4xl">
            {/* Hugo avatar inline when speaking */}
            {isSpeaking && (
              <div className="flex justify-start">
                <HugoAvatar isSpeaking={true} size={48} />
              </div>
            )}
            {messages.map((msg) => (
              <ChatBubble
                key={msg.id}
                message={msg}
                onReplay={
                  msg.id === latestAssistantId ? () => handleReplay(msg.id, msg.content) : undefined
                }
              />
            ))}
          </div>
        )}
      </div>

      {/* Mic area */}
      <div
        className="px-4 pt-8 pb-12"
        style={{ background: "transparent", border: "none", width: "100%" }}
      >
        <div className="mx-auto flex w-full max-w-lg justify-center lg:max-w-3xl xl:max-w-4xl">
          <MicButton
            isRecording={isRecording}
            isProcessing={isProcessing}
            onRecordStart={handleRecordStart}
            onRecordStop={handleRecordStop}
          />
        </div>
      </div>

      {/* Clear conversation — sits at the bottom of the page content, just
          above the footer's border-top separator. mt-auto pushes it down so
          it hugs the footer regardless of how tall the rest of the page is. */}
      {messages.length > 0 && (
        <div className="mt-auto flex w-full justify-center pb-3">
          <button
            onClick={handleNewSession}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
            title="Clear conversation and start fresh"
          >
            <Trash2 className="h-3 w-3" />
            Clear conversation
          </button>
        </div>
      )}
    </div>
  );
}
