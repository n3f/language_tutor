/**
 * Streams a chat completion via OpenAI's `/v1/chat/completions` SSE protocol
 * and emits complete sentences to a callback as they arrive. The file is named
 * `groq-stream` for historical reasons (the app originally used Groq's
 * OpenAI-compatible endpoint); the wire format is the same either way.
 *
 * Why split on sentence boundaries: the TTS layer downstream issues one
 * `/v1/audio/speech` request per sentence so it can begin playback as soon as
 * the first one finishes (rather than waiting for the whole reply). The
 * splitter therefore needs to produce well-formed sentence chunks the moment
 * they're complete — never mid-sentence.
 *
 * Two flushing modes:
 *  - First chunk: emit on ANY natural pause (.,;:?!…—) once ≥25 chars are
 *    buffered, so the user hears speech as fast as physically possible.
 *  - Subsequent chunks: only on true sentence terminators (.?!…), so prosody
 *    stays natural for the rest of the reply.
 */

export interface GroqMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface StreamOptions {
  apiKey: string;
  messages: GroqMessage[];
  model?: string;
  onSentence: (sentence: string) => void;
  onToken: (fullText: string) => void;
  onDone: (fullText: string) => void;
  onError: (error: Error) => void;
  signal?: AbortSignal;
}

const SENTENCE_END = /([.?!…])\s/g;
// For the FIRST chunk only, also flush on commas, semicolons, colons, and em-dashes
// so the first audio plays sooner (e.g. after "« correction » —" in a correction reply).
const FIRST_CHUNK_BOUNDARY = /([.,;:?!…—])\s/g;
const MIN_FIRST_CHUNK_CHARS = 25;

export async function streamGroqChat({
  apiKey,
  messages,
  model = "gpt-4o-mini",
  onSentence,
  onToken,
  onDone,
  onError,
  signal,
}: StreamOptions): Promise<void> {
  try {
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages,
        stream: true,
      }),
      signal,
    });

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`OpenAI API ${resp.status}: ${errText}`);
    }

    if (!resp.body) throw new Error("No response body");

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let fullText = "";
    let sentenceBuffer = "";
    let textBuffer = "";
    let firstChunkFlushed = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      textBuffer += decoder.decode(value, { stream: true });

      let newlineIdx: number;
      while ((newlineIdx = textBuffer.indexOf("\n")) !== -1) {
        let line = textBuffer.slice(0, newlineIdx);
        textBuffer = textBuffer.slice(newlineIdx + 1);

        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (!line.startsWith("data: ")) continue;

        const jsonStr = line.slice(6).trim();
        if (jsonStr === "[DONE]") continue;

        try {
          const parsed = JSON.parse(jsonStr);
          const content = parsed.choices?.[0]?.delta?.content as string | undefined;
          if (!content) continue;

          fullText += content;
          sentenceBuffer += content;
          onToken(fullText);

          // First chunk: split on any natural pause (.,;:?!…—) once ≥25 chars
          // accumulated so the first audio plays as soon as possible.
          // Subsequent chunks: only on sentence-ending punctuation.
          const regex = firstChunkFlushed ? SENTENCE_END : FIRST_CHUNK_BOUNDARY;
          let match: RegExpExecArray | null;
          let lastEnd = 0;
          regex.lastIndex = 0;

          while ((match = regex.exec(sentenceBuffer)) !== null) {
            const sentenceEnd = match.index + match[1].length;
            const sentence = sentenceBuffer.slice(lastEnd, sentenceEnd).trim();
            if (firstChunkFlushed) {
              if (sentence) onSentence(sentence);
              lastEnd = match.index + match[0].length;
            } else if (sentence.length >= MIN_FIRST_CHUNK_CHARS) {
              onSentence(sentence);
              firstChunkFlushed = true;
              lastEnd = match.index + match[0].length;
            }
            // else: too-short candidate, skip and look for the next boundary
          }

          if (lastEnd > 0) {
            sentenceBuffer = sentenceBuffer.slice(lastEnd);
          }
        } catch {
          // partial JSON, ignore
        }
      }
    }

    // Flush remaining buffer as final sentence
    const remaining = sentenceBuffer.trim();
    if (remaining) onSentence(remaining);

    onDone(fullText);
  } catch (err) {
    if (signal?.aborted) return;
    onError(err instanceof Error ? err : new Error(String(err)));
  }
}
