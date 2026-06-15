/**
 * Shared chat message type. Lives at module scope (rather than inside
 * `conversation-state.ts`) because both the persisted store and any UI
 * component that renders a bubble need to agree on the shape.
 *
 * `correction` flags an assistant turn that opened with a correction quote;
 * components use it to render the correction-style bubble (a different
 * background to visually separate teaching content from chitchat).
 */
export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: Date;
  correction?: boolean;
}
