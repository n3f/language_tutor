import { Play } from "lucide-react";
import type { ChatMessage } from "@/lib/app-state";

interface ChatBubbleProps {
  message: ChatMessage;
  /** When set, renders a small play button in the bottom-right corner that
   * triggers TTS replay of this message. Only passed for the latest assistant
   * message so older bubbles stay clean. */
  onReplay?: () => void;
}

export function ChatBubble({ message, onReplay }: ChatBubbleProps) {
  const isUser = message.role === "user";

  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"} animate-fade-in`}>
      <div
        className={`max-w-[75%] rounded-2xl ${
          isUser
            ? "bg-primary rounded-br-md"
            : message.correction
              ? "border-l-[3px] border-l-correction bg-card/80 border border-border rounded-bl-md"
              : "bg-card border border-border rounded-bl-md"
        }`}
        style={{ padding: "16px 20px" }}
      >
        <p
          className={`whitespace-pre-wrap ${isUser ? "text-primary-foreground" : "text-foreground"}`}
          style={{ fontSize: "17px", lineHeight: 1.65, letterSpacing: "0.01em" }}
        >
          {message.content}
        </p>
        <div className="mt-1.5 flex items-center justify-between gap-3">
          <time
            className={isUser ? "text-primary-foreground/55" : "text-muted-foreground"}
            style={{ fontSize: "13px" }}
          >
            {message.timestamp.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </time>
          {onReplay && (
            <button
              onClick={onReplay}
              className="text-muted-foreground hover:text-foreground transition-colors"
              title="Replay this message"
              aria-label="Replay this message"
              style={{
                background: "none",
                border: "none",
                cursor: "pointer",
                padding: "2px",
                display: "inline-flex",
                alignItems: "center",
              }}
            >
              <Play style={{ width: "14px", height: "14px" }} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
