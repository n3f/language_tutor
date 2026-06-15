/**
 * Settings page — surfaces every knob the practice loop reads at chat time.
 *
 * Persistence layers used here:
 *  - `localStorage["fvt_config"]`: name, API keys, language, TTS voice/speed.
 *    Read by index.tsx via getConfig() on every recording turn.
 *  - `localStorage["fvt_kb"]` + `fvt_kb_meta`: imported KB file (parsed JSON)
 *    and import metadata. Read by prompt-store.buildKbAddendum() at chat time.
 *  - `localStorage["fvt_level"]`: conversation level (beginner/inter/adv).
 *    Read by prompt-store.getSavedLevel().
 *  - IndexedDB `fvt_prompt_db`: the user-editable system prompt prose.
 *
 * Language changes propagate end-to-end via `applyLanguageChange`: it persists
 * the new code, rewrites the LANGUAGE section in the textarea preview, saves
 * the prompt if it's custom, and clears chat history so the next turn doesn't
 * arrive in a now-stale language.
 */
import { createFileRoute } from "@tanstack/react-router";
import { useState, useEffect, useCallback, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import {
  Trash2,
  Upload,
  Key,
  Volume2,
  Save,
  CheckCircle,
  MessageSquare,
  FileText,
} from "lucide-react";
import { toast } from "sonner";
import { LANGUAGES, type LanguageCode } from "@/lib/language-config";
import {
  type ConversationLevel,
  getSavedLevel,
  saveLevel,
  buildBaseSystemPrompt,
  saveCustomPrompt,
  loadCustomPrompt,
  replaceLevelInPrompt,
  replaceLanguageInPrompt,
  stripKbSections,
} from "@/lib/prompt-store";
import { clearConversation } from "@/lib/conversation-state";

export const Route = createFileRoute("/settings")({
  head: () => ({
    meta: [
      { title: "Settings — AI-powered Language Practice" },
      { name: "description", content: "Configure your settings" },
    ],
  }),
  component: SettingsPage,
});

function SettingsPage() {
  const kbInputRef = useRef<HTMLInputElement>(null);
  const [userName, setUserName] = useState("");
  const [groqApiKey, setGroqApiKey] = useState("");
  const [openaiApiKey, setOpenaiApiKey] = useState("");
  const [groqValidating, setGroqValidating] = useState(false);
  const [groqValidated, setGroqValidated] = useState(false);
  const [openaiValidating, setOpenaiValidating] = useState(false);
  const [openaiValidated, setOpenaiValidated] = useState(false);
  const [ttsVoice, setTtsVoice] = useState<"nova" | "onyx">("nova");
  const [language, setLanguage] = useState<LanguageCode>("fr");
  const [ttsSpeed, setTtsSpeed] = useState("1");
  const [saved, setSaved] = useState(false);
  const [kbFileName, setKbFileName] = useState<string | null>(null);
  const [kbLastSync, setKbLastSync] = useState<string | null>(null);
  const [level, setLevel] = useState<ConversationLevel>(getSavedLevel());
  const [promptText, setPromptText] = useState("");
  const [hasCustomPrompt, setHasCustomPrompt] = useState(false);
  const [levelNotice, setLevelNotice] = useState(false);

  // Load saved config on mount
  useEffect(() => {
    try {
      const raw = localStorage.getItem("fvt_config");
      if (raw) {
        const cfg = JSON.parse(raw);
        if (cfg.userName) setUserName(cfg.userName);
        if (cfg.groqApiKey) {
          setGroqApiKey(cfg.groqApiKey);
          setGroqValidated(true);
        }
        if (cfg.openaiApiKey) {
          setOpenaiApiKey(cfg.openaiApiKey);
          setOpenaiValidated(true);
        }
        if (cfg.language && cfg.language in LANGUAGES) setLanguage(cfg.language as LanguageCode);
        if (cfg.ttsVoice === "onyx" || cfg.ttsVoice === "nova") setTtsVoice(cfg.ttsVoice);
        if (cfg.ttsSpeed) setTtsSpeed(cfg.ttsSpeed);
      }
      const kbMeta = localStorage.getItem("fvt_kb_meta");
      if (kbMeta) {
        const meta = JSON.parse(kbMeta);
        if (meta.fileName) setKbFileName(meta.fileName);
        if (meta.lastSync) setKbLastSync(meta.lastSync);
      }
    } catch {
      /* ignore */
    }

    // Load prompt from IndexedDB or generate default base. Dynamic sections
    // (LANGUAGE, KB sections) are stripped from the saved content — they're
    // rebuilt at chat time from settings. For the textarea preview we re-
    // insert a fresh LANGUAGE section after ROLE so the user sees what their
    // prompt actually looks like at chat time. ROLE is preserved as-is
    // because it's user-editable.
    loadCustomPrompt()
      .then((saved) => {
        if (saved) {
          // replaceLanguageInPrompt handles the legacy "ROLE AND LANGUAGE"
          // migration internally, and inserts a fresh LANGUAGE after ROLE.
          const stripped = stripKbSections(saved).trim();
          const preview = stripped
            ? replaceLanguageInPrompt(stripped, getSavedLanguageCode())
            : buildBaseSystemPrompt();
          setPromptText(preview);
          setHasCustomPrompt(true);
        } else {
          setPromptText(buildBaseSystemPrompt());
        }
      })
      .catch(() => {
        setPromptText(buildBaseSystemPrompt());
      });
  }, []);

  /** Read the language code from fvt_config without touching React state.
   * Used at mount to seed the textarea preview with the right language. */
  function getSavedLanguageCode(): LanguageCode {
    try {
      const raw = localStorage.getItem("fvt_config");
      if (raw) {
        const cfg = JSON.parse(raw);
        if (cfg.language && cfg.language in LANGUAGES) return cfg.language as LanguageCode;
      }
    } catch {
      /* ignore */
    }
    return "fr";
  }

  /** Set the practice language in React state AND persist it to fvt_config immediately,
   * so a chat turn started before clicking "Save Settings" already uses the new language. */
  const persistLanguage = useCallback((newLang: LanguageCode) => {
    setLanguage(newLang);
    try {
      const raw = localStorage.getItem("fvt_config");
      const cfg = raw ? JSON.parse(raw) : {};
      cfg.language = newLang;
      localStorage.setItem("fvt_config", JSON.stringify(cfg));
    } catch {
      /* ignore */
    }
  }, []);

  /** Apply a language change end-to-end: persist to settings, update the prompt textarea,
   * save the updated prompt if the user has a custom one, and clear the conversation
   * history (so the next chat turn doesn't see exchanges from the previous language).
   * Used by both the dropdown and the KB-import auto-set path so they stay symmetric. */
  const applyLanguageChange = useCallback(
    (newLang: LanguageCode) => {
      const changed = language !== newLang;
      persistLanguage(newLang);
      setPromptText((prev) => {
        const updated = replaceLanguageInPrompt(prev, newLang);
        if (hasCustomPrompt && updated !== prev) {
          saveCustomPrompt(updated).catch(() => {});
        }
        return updated;
      });
      if (changed) {
        // Wipe any stale-language history so the practice page starts the
        // next turn fresh in the newly-selected language.
        clearConversation();
      }
    },
    [language, persistLanguage, hasCustomPrompt],
  );

  const handleKbImport = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      if (file.size > 5 * 1024 * 1024) {
        toast.error("KB file must be under 5 MB");
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const data = JSON.parse(reader.result as string);
          localStorage.setItem("fvt_kb", JSON.stringify(data));
          const now = new Date().toLocaleString();
          localStorage.setItem(
            "fvt_kb_meta",
            JSON.stringify({ fileName: file.name, lastSync: now }),
          );
          setKbFileName(file.name);
          setKbLastSync(now);
          // Auto-set language from KB if present: persist to config AND sync any custom prompt's
          // language reference so the chat doesn't end up with a Russian prompt and a French KB.
          if (data.language && data.language in LANGUAGES) {
            applyLanguageChange(data.language as LanguageCode);
            toast.success(
              `KB file "${file.name}" imported — language set to ${LANGUAGES[data.language as LanguageCode].label}`,
            );
          } else {
            toast.success(`KB file "${file.name}" imported successfully`);
          }
        } catch {
          toast.error("Invalid JSON file. Please select a valid KB file.");
        }
      };
      reader.onerror = () => toast.error("Failed to read file.");
      reader.readAsText(file);
      // reset so re-selecting the same file triggers onChange
      e.target.value = "";
    },
    [applyLanguageChange],
  );

  const handleLevelChange = useCallback(
    (newLevel: ConversationLevel) => {
      setLevel(newLevel);
      saveLevel(newLevel);
      setPromptText((prev) => {
        const updated = replaceLevelInPrompt(prev, newLevel);
        if (hasCustomPrompt && updated !== prev) {
          setLevelNotice(true);
          setTimeout(() => setLevelNotice(false), 4000);
          // Auto-save updated custom prompt
          saveCustomPrompt(updated).catch(() => {});
        }
        return updated;
      });
    },
    [hasCustomPrompt],
  );

  const handleResetPrompt = useCallback(() => {
    const defaultPrompt = buildBaseSystemPrompt(level);
    setPromptText(defaultPrompt);
    setHasCustomPrompt(false);
    // Clear from IndexedDB
    import("@/lib/prompt-store").then((m) => m.clearCustomPrompt()).catch(() => {});
    toast.success("Prompt reset to default");
  }, [level]);

  const handleSave = useCallback(async () => {
    // Validate Groq key with a minimal chat completion call
    if (groqApiKey && !groqValidated) {
      setGroqValidating(true);
      try {
        const resp = await fetch("https://api.groq.com/openai/v1/models", {
          headers: { Authorization: `Bearer ${groqApiKey}` },
        });
        if (!resp.ok) throw new Error(String(resp.status));
        setGroqValidated(true);
      } catch {
        setGroqValidating(false);
        toast.error("Could not connect to Groq — check your API key.");
        return;
      }
      setGroqValidating(false);
    }

    // Validate OpenAI key with a minimal TTS call
    if (openaiApiKey && !openaiValidated) {
      setOpenaiValidating(true);
      try {
        const resp = await fetch("https://api.openai.com/v1/audio/speech", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${openaiApiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ model: "tts-1", input: "hi", voice: "nova" }),
        });
        if (!resp.ok) throw new Error(String(resp.status));
        setOpenaiValidated(true);
      } catch {
        setOpenaiValidating(false);
        toast.error("Could not connect to OpenAI — check your API key.");
        return;
      }
      setOpenaiValidating(false);
    }

    const config = {
      userName,
      groqApiKey,
      openaiApiKey,
      language,
      ttsVoice,
      ttsSpeed,
    };
    localStorage.setItem("fvt_config", JSON.stringify(config));

    // Persist the system prompt alongside the rest of the settings. Strip any
    // KB sections defensively so the saved base stays clean.
    try {
      const cleaned = stripKbSections(promptText).trim();
      await saveCustomPrompt(cleaned);
      if (cleaned !== promptText) setPromptText(cleaned);
      setHasCustomPrompt(true);
    } catch {
      toast.error("Failed to save system prompt.");
    }

    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }, [
    userName,
    groqApiKey,
    groqValidated,
    openaiApiKey,
    openaiValidated,
    ttsVoice,
    ttsSpeed,
    language,
    promptText,
  ]);

  return (
    <div className="mx-auto max-w-lg px-4 py-6 lg:max-w-2xl">
      <h1 className="text-xl font-bold text-foreground">Settings</h1>
      <p className="mt-1 text-sm text-muted-foreground">Configure your tutor experience.</p>

      <div className="mt-6 space-y-6">
        {/* Profile */}
        <section className="space-y-3">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <Key className="h-4 w-4 text-primary" /> Profile & API Keys
          </h2>
          <div className="space-y-3 rounded-lg border border-border bg-card p-4">
            <div>
              <Label htmlFor="name">Your name</Label>
              <Input
                id="name"
                value={userName}
                onChange={(e) => setUserName(e.target.value)}
                placeholder="e.g. Lana"
                className="mt-1"
              />
            </div>
            <div>
              <Label htmlFor="groq-key" className="flex items-center gap-2">
                Groq API Key
                {groqValidated && <CheckCircle className="h-3 w-3 text-green-500" />}
              </Label>
              <Input
                id="groq-key"
                type="password"
                value={groqApiKey}
                onChange={(e) => {
                  setGroqApiKey(e.target.value);
                  setGroqValidated(false);
                }}
                placeholder="gsk_..."
                className="mt-1 font-mono text-xs"
              />
              <p className="mt-1 text-[10px] text-muted-foreground">
                Get yours at{" "}
                <a
                  href="https://console.groq.com"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary underline"
                >
                  console.groq.com
                </a>
              </p>
            </div>
            <div>
              <Label htmlFor="openai-key" className="flex items-center gap-2">
                OpenAI API Key
                {openaiValidated && <CheckCircle className="h-3 w-3 text-green-500" />}
              </Label>
              <Input
                id="openai-key"
                type="password"
                value={openaiApiKey}
                onChange={(e) => {
                  setOpenaiApiKey(e.target.value);
                  setOpenaiValidated(false);
                }}
                placeholder="sk-..."
                className="mt-1 font-mono text-xs"
              />
              <p className="mt-1 text-[10px] text-muted-foreground">
                Get yours at{" "}
                <a
                  href="https://platform.openai.com"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary underline"
                >
                  platform.openai.com
                </a>
              </p>
            </div>
          </div>
        </section>

        {/* Voice */}
        <section className="space-y-3">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <Volume2 className="h-4 w-4 text-primary" /> Voice Settings
          </h2>
          <div className="space-y-3 rounded-lg border border-border bg-card p-4">
            <div>
              <Label>Practice Language</Label>
              <select
                value={language}
                onChange={(e) => {
                  applyLanguageChange(e.target.value as LanguageCode);
                }}
                className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground"
              >
                {Object.values(LANGUAGES).map((lang) => (
                  <option
                    key={lang.code}
                    value={lang.code}
                    className={lang.beta ? "text-muted-foreground" : undefined}
                    style={lang.beta ? { color: "var(--muted-foreground)" } : undefined}
                  >
                    {lang.label}
                    {lang.beta ? " (beta)" : ""}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label>TTS Voice</Label>
              <div className="mt-1 flex gap-2">
                <button
                  onClick={() => setTtsVoice("nova")}
                  className={`flex-1 rounded-md border px-3 py-2 text-sm transition-colors ${
                    ttsVoice === "nova"
                      ? "border-primary bg-primary/10 text-foreground"
                      : "border-border text-muted-foreground hover:bg-accent"
                  }`}
                >
                  Nova (♀)
                </button>
                <button
                  onClick={() => setTtsVoice("onyx")}
                  className={`flex-1 rounded-md border px-3 py-2 text-sm transition-colors ${
                    ttsVoice === "onyx"
                      ? "border-primary bg-primary/10 text-foreground"
                      : "border-border text-muted-foreground hover:bg-accent"
                  }`}
                >
                  Onyx (♂)
                </button>
              </div>
            </div>
            <div>
              <Label htmlFor="speed">TTS Speed</Label>
              <select
                id="speed"
                value={ttsSpeed}
                onChange={(e) => setTtsSpeed(e.target.value)}
                className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground"
              >
                <option value="0.8">0.8× (Slower)</option>
                <option value="1">1× (Normal)</option>
                <option value="1.2">1.2× (Faster)</option>
              </select>
            </div>
          </div>
        </section>

        {/* Conversation Level */}
        <section className="space-y-3">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <MessageSquare className="h-4 w-4 text-primary" /> Conversation Level
          </h2>
          <div className="rounded-lg border border-border bg-card p-4">
            <div className="flex gap-2">
              {(["beginner", "intermediate", "advanced"] as ConversationLevel[]).map((lvl) => (
                <button
                  key={lvl}
                  onClick={() => handleLevelChange(lvl)}
                  className={`flex-1 rounded-md border px-3 py-2 text-sm capitalize transition-colors ${
                    level === lvl
                      ? "border-primary bg-primary/10 text-foreground"
                      : "border-border text-muted-foreground hover:bg-accent"
                  }`}
                >
                  {lvl}
                </button>
              ))}
            </div>
            {levelNotice && (
              <p className="mt-1 text-[10px] text-primary">Level updated in your custom prompt.</p>
            )}
          </div>
        </section>

        {/* System Prompt */}
        <section className="space-y-3">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <FileText className="h-4 w-4 text-primary" /> System Prompt
          </h2>
          <div className="rounded-lg border border-border bg-card p-4 space-y-3">
            <p className="text-[10px] text-muted-foreground">
              You can edit <strong>ROLE</strong>, <strong>WHEN TO CORRECT</strong>,{" "}
              <strong>HOW TO CORRECT</strong>, and <strong>CONVERSATION STYLE</strong> freely. The{" "}
              <strong>LANGUAGE</strong> section is generated from the language dropdown above, and
              the <strong>CONVERSATION LEVEL</strong> section is generated from the level buttons
              above — edits to those two sections here will be overwritten when those controls
              change or at chat time.
            </p>
            <p className="text-[10px] text-muted-foreground">
              Your knowledge base (name, target structures, weak spots, extra instructions) is
              appended automatically at chat time when a KB file is loaded — don't paste it here.
            </p>
            <textarea
              value={promptText}
              onChange={(e) => setPromptText(e.target.value)}
              style={{
                width: "100%",
                minHeight: "300px",
                background: "var(--surface)",
                border: "1px solid var(--border)",
                borderRadius: "8px",
                padding: "12px",
                fontFamily: "Inter, sans-serif",
                fontSize: "13px",
                color: "var(--foreground)",
                lineHeight: 1.6,
                resize: "vertical",
              }}
            />
            <div className="flex justify-center">
              <Button onClick={handleResetPrompt} variant="outline" size="sm">
                Reset to Default
              </Button>
            </div>
          </div>
        </section>

        {/* KB file */}
        <section className="space-y-3">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <Upload className="h-4 w-4 text-primary" /> Knowledge Base
          </h2>
          <div className="rounded-lg border border-border bg-card p-4">
            <p className="text-xs text-muted-foreground">
              {kbFileName
                ? `Loaded: ${kbFileName}`
                : "No KB file loaded. Tap below to import your learning profile."}
            </p>
            <input
              ref={kbInputRef}
              type="file"
              accept=".json,application/json"
              className="hidden"
              onChange={handleKbImport}
            />
            <Button
              variant="outline"
              size="sm"
              className="mt-3 w-full"
              onClick={() => kbInputRef.current?.click()}
            >
              Import KB File
            </Button>
            <p className="mt-2 text-[10px] text-muted-foreground">
              Last synced: {kbLastSync ?? "never"}
            </p>
          </div>
        </section>

        {/* Danger zone */}
        <section className="space-y-3">
          <Button
            onClick={handleSave}
            size="sm"
            className="w-full gap-2"
            disabled={groqValidating || openaiValidating}
          >
            {saved ? <CheckCircle className="h-4 w-4" /> : <Save className="h-4 w-4" />}
            {groqValidating || openaiValidating
              ? "Validating..."
              : saved
                ? "Saved!"
                : "Save Settings"}
          </Button>
          <Button
            variant="destructive"
            size="sm"
            className="w-full gap-2"
            onClick={() => {
              localStorage.removeItem("fvt_config");
              localStorage.removeItem("fvt_kb");
              localStorage.removeItem("fvt_kb_meta");
              localStorage.removeItem("fvt_level");
              localStorage.removeItem("fvt_theme");
              indexedDB.deleteDatabase("fvt_prompt_db");
              setUserName("");
              setGroqApiKey("");
              setGroqValidated(false);
              setOpenaiApiKey("");
              setOpenaiValidated(false);
              setKbFileName(null);
              setKbLastSync(null);
              setPromptText(buildBaseSystemPrompt());
              setHasCustomPrompt(false);
              toast.success("All data cleared");
            }}
          >
            <Trash2 className="h-4 w-4" /> Clear All Data
          </Button>
          <p className="text-center text-[10px] text-muted-foreground">
            This will erase all saved keys, settings, and cached files from your browser.
          </p>
        </section>
      </div>
    </div>
  );
}
