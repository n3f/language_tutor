import { Mic, Square, Loader2 } from "lucide-react";
import { useCallback } from "react";

interface MicButtonProps {
  isRecording: boolean;
  isProcessing: boolean;
  onRecordStart: () => void;
  onRecordStop: () => void;
}

export function MicButton({
  isRecording,
  isProcessing,
  onRecordStart,
  onRecordStop,
}: MicButtonProps) {
  const handleClick = useCallback(() => {
    if (isProcessing) return;
    if (isRecording) {
      onRecordStop();
    } else {
      onRecordStart();
    }
  }, [isProcessing, isRecording, onRecordStart, onRecordStop]);

  return (
    <div className="flex flex-col items-center gap-2">
      <button
        onClick={handleClick}
        disabled={isProcessing}
        style={
          isRecording
            ? { backgroundColor: "var(--recording)" }
            : isProcessing
              ? {}
              : { boxShadow: "0 0 24px color-mix(in oklch, var(--primary), transparent 70%)" }
        }
        className={`flex h-[80px] w-[80px] items-center justify-center rounded-full transition-all duration-200 select-none touch-none ${
          isRecording
            ? "bg-recording text-foreground animate-mic-pulse scale-110"
            : isProcessing
              ? "bg-muted text-muted-foreground cursor-wait"
              : "bg-primary text-primary-foreground hover:bg-primary/90 active:scale-95"
        }`}
        aria-label={isRecording ? "Tap to stop" : "Tap to start"}
      >
        {isProcessing ? (
          <Loader2 className="h-8 w-8 animate-spin" />
        ) : isRecording ? (
          <Square className="h-6 w-6 fill-current" />
        ) : (
          <Mic className="h-8 w-8" />
        )}
      </button>
      <span className="text-xs text-muted-foreground">
        {isProcessing ? "Processing…" : isRecording ? "Tap to stop" : "Tap to start"}
      </span>
    </div>
  );
}
