import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Lock, Fingerprint } from "lucide-react";

export const Route = createFileRoute("/unlock")({
  head: () => ({
    meta: [{ title: "Unlock — AI-powered Language Practice" }],
  }),
  component: UnlockPage,
});

function UnlockPage() {
  const navigate = useNavigate();
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const [attempts, setAttempts] = useState(0);
  const [locked, setLocked] = useState(false);
  const webauthnAvailable = typeof window !== "undefined" && !!window.PublicKeyCredential;

  const handlePinSubmit = () => {
    // Would validate against stored encrypted PIN here
    if (pin.length < 4) {
      setError("PIN must be at least 4 digits");
      return;
    }
    // Simulated success for now
    navigate({ to: "/" });
  };

  const handleTouchId = async () => {
    // Would call navigator.credentials.get() here
    navigate({ to: "/" });
  };

  return (
    <div className="flex min-h-[100dvh] flex-col items-center justify-center px-6">
      <div className="w-full max-w-xs text-center">
        {/* Lock icon */}
        <div className="mx-auto mb-6 flex h-20 w-20 items-center justify-center rounded-full bg-primary/10">
          <Lock className="h-10 w-10 text-primary" />
        </div>

        <h1 className="text-xl font-bold text-foreground">Welcome back</h1>
        <p className="mt-1 text-sm text-muted-foreground">Unlock to continue your practice</p>

        {/* Touch ID button */}
        {webauthnAvailable && (
          <Button onClick={handleTouchId} className="mt-6 w-full gap-2" size="lg">
            <Fingerprint className="h-5 w-5" />
            Unlock with Touch ID
          </Button>
        )}

        {/* PIN entry */}
        <div className="mt-6">
          {webauthnAvailable && (
            <p className="mb-3 text-xs text-muted-foreground">or use your PIN</p>
          )}
          <Input
            type="password"
            inputMode="numeric"
            maxLength={8}
            value={pin}
            onChange={(e) => {
              setPin(e.target.value.replace(/\D/g, ""));
              setError("");
            }}
            onKeyDown={(e) => e.key === "Enter" && handlePinSubmit()}
            placeholder="Enter PIN"
            className="text-center text-lg tracking-[0.5em]"
            disabled={locked}
          />
          {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
          {locked && (
            <p className="mt-2 text-xs text-destructive">
              Too many attempts. Try again in 30 seconds.
            </p>
          )}
          <Button
            onClick={handlePinSubmit}
            variant="outline"
            className="mt-3 w-full"
            disabled={pin.length < 4 || locked}
          >
            Unlock with PIN
          </Button>
        </div>
      </div>
    </div>
  );
}
