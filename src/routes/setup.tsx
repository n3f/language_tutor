import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { HugoAvatar } from "@/components/HugoAvatar";

export const Route = createFileRoute("/setup")({
  head: () => ({
    meta: [
      { title: "Setup — AI-powered Language Practice" },
      { name: "description", content: "Set up your language practice tutor" },
    ],
  }),
  component: SetupPage,
});

function SetupPage() {
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [name, setName] = useState("");
  const [groqKey, setGroqKey] = useState("");
  const [openaiKey, setOpenaiKey] = useState("");
  const [pin, setPin] = useState("");
  const [pinConfirm, setPinConfirm] = useState("");

  const steps = [
    { title: "Welcome", subtitle: "Let's get you set up for language practice" },
    { title: "API Keys", subtitle: "Connect to Groq and OpenAI" },
    { title: "Security", subtitle: "Set a PIN to protect your data" },
  ];

  const canProceed = () => {
    if (step === 0) return name.trim().length > 0;
    if (step === 1) return groqKey.trim().length > 0 && openaiKey.trim().length > 0;
    if (step === 2) return pin.length >= 4 && pin === pinConfirm;
    return false;
  };

  const handleNext = () => {
    if (step < steps.length - 1) {
      setStep(step + 1);
    } else {
      // Setup complete — would encrypt & save here
      navigate({ to: "/" });
    }
  };

  return (
    <div className="flex min-h-[100dvh] flex-col items-center justify-center px-6 py-10">
      <div className="w-full max-w-sm">
        {/* Hugo greeting */}
        <div className="mb-6 flex flex-col items-center">
          <HugoAvatar isSpeaking={false} size={100} />
          <h1 className="mt-4 text-xl font-bold text-foreground">{steps[step].title}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{steps[step].subtitle}</p>
        </div>

        {/* Progress dots */}
        <div className="mb-6 flex justify-center gap-2">
          {steps.map((_, i) => (
            <div
              key={i}
              className={`h-2 rounded-full transition-all ${
                i === step ? "w-8 bg-primary" : i < step ? "w-2 bg-primary/50" : "w-2 bg-muted"
              }`}
            />
          ))}
        </div>

        {/* Step content */}
        <div className="space-y-4 animate-fade-in">
          {step === 0 && (
            <div>
              <Label htmlFor="setup-name">What should we call you?</Label>
              <Input
                id="setup-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Lana, Alex"
                className="mt-1"
                autoFocus
              />
            </div>
          )}

          {step === 1 && (
            <>
              <div>
                <Label htmlFor="groq-key">Groq API Key</Label>
                <Input
                  id="groq-key"
                  type="password"
                  value={groqKey}
                  onChange={(e) => setGroqKey(e.target.value)}
                  placeholder="gsk_..."
                  className="mt-1 font-mono text-xs"
                />
                <a
                  href="https://console.groq.com"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-1 inline-block text-xs text-primary underline"
                >
                  Get your Groq key →
                </a>
              </div>
              <div>
                <Label htmlFor="openai-key">OpenAI API Key</Label>
                <Input
                  id="openai-key"
                  type="password"
                  value={openaiKey}
                  onChange={(e) => setOpenaiKey(e.target.value)}
                  placeholder="sk-..."
                  className="mt-1 font-mono text-xs"
                />
                <a
                  href="https://platform.openai.com"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-1 inline-block text-xs text-primary underline"
                >
                  Get yours at platform.openai.com →
                </a>
              </div>
            </>
          )}

          {step === 2 && (
            <>
              <div>
                <Label htmlFor="pin">Create a PIN (4–8 digits)</Label>
                <Input
                  id="pin"
                  type="password"
                  inputMode="numeric"
                  maxLength={8}
                  value={pin}
                  onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
                  placeholder="••••"
                  className="mt-1 text-center text-lg tracking-[0.5em]"
                />
              </div>
              <div>
                <Label htmlFor="pin-confirm">Confirm PIN</Label>
                <Input
                  id="pin-confirm"
                  type="password"
                  inputMode="numeric"
                  maxLength={8}
                  value={pinConfirm}
                  onChange={(e) => setPinConfirm(e.target.value.replace(/\D/g, ""))}
                  placeholder="••••"
                  className="mt-1 text-center text-lg tracking-[0.5em]"
                />
                {pinConfirm.length > 0 && pin !== pinConfirm && (
                  <p className="mt-1 text-xs text-destructive">PINs don't match</p>
                )}
              </div>
            </>
          )}
        </div>

        {/* Actions */}
        <div className="mt-6 flex gap-3">
          {step > 0 && (
            <Button variant="outline" onClick={() => setStep(step - 1)} className="flex-1">
              Back
            </Button>
          )}
          <Button onClick={handleNext} disabled={!canProceed()} className="flex-1">
            {step === steps.length - 1 ? "Start Practicing" : "Continue"}
          </Button>
        </div>
      </div>
    </div>
  );
}
