/**
 * Shared chat-history state for the practice page.
 *
 * Lives at the module level (not React state) so it survives navigation
 * between routes — e.g. user switches to Settings and back, the messages
 * are still there. Reset on full page reload because the module is
 * re-evaluated.
 *
 * Owning this outside the Index route component lets other parts of the
 * app (notably settings.tsx, which clears conversation on language change)
 * touch the same state without prop-drilling or context.
 */

import type { ChatMessage } from "@/lib/app-state";
import type { GroqMessage } from "@/lib/groq-stream";

let persistedMessages: ChatMessage[] = [];
let persistedConversation: GroqMessage[] = [];
const messageListeners = new Set<(msgs: ChatMessage[]) => void>();

export function getPersistedMessages(): ChatMessage[] {
  return persistedMessages;
}

export function setPersistedMessages(msgs: ChatMessage[]): void {
  persistedMessages = msgs;
  messageListeners.forEach((fn) => fn(msgs));
}

export function updatePersistedMessages(updater: (prev: ChatMessage[]) => ChatMessage[]): void {
  setPersistedMessages(updater(persistedMessages));
}

export function getPersistedConversation(): GroqMessage[] {
  return persistedConversation;
}

export function setPersistedConversation(conv: GroqMessage[]): void {
  persistedConversation = conv;
}

export function subscribeMessages(fn: (msgs: ChatMessage[]) => void): () => void {
  messageListeners.add(fn);
  return () => {
    messageListeners.delete(fn);
  };
}

/** Reset both the UI message list and the LLM-facing conversation array.
 * Called from the practice page's "Clear conversation" button and from
 * settings.tsx whenever the practice language changes. */
export function clearConversation(): void {
  persistedConversation = [];
  setPersistedMessages([]);
}
