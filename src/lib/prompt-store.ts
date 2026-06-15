/**
 * System-prompt assembly and persistence for the chat loop.
 *
 * The final system prompt sent to the LLM is composed at chat time from two
 * sources of truth:
 *
 *  - User-editable prose (the saved "base" prompt): the assistant's role,
 *    correction policy, and conversation style. Persisted in IndexedDB so it
 *    survives reloads and can be edited from the Settings page.
 *  - Data-derived sections: LANGUAGE (from the language dropdown), and KB
 *    content (name, due topics, weak spots, additional instructions). These
 *    are stripped from whatever was saved and rebuilt fresh on every call so
 *    a stale dropdown setting or KB edit can never leak into a chat turn.
 *
 * Section boundaries are triple-newlines and headers are uppercase ASCII —
 * cheap to split on without a parser. See `composeFinalPrompt` for the
 * insertion order rules. The ROLE → LANGUAGE → ... → KB addendum →
 * CONVERSATION LEVEL ordering is deliberate: it keeps the stable prefix
 * (cacheable by the OpenAI API) as long as possible and pushes
 * date-volatile content (due-today topics) toward the end.
 */
import { getEffectiveLanguage, getLanguageConfig, type LanguageCode } from "@/lib/language-config";

export type ConversationLevel = "beginner" | "intermediate" | "advanced";

export const LEVEL_INSTRUCTIONS: Record<ConversationLevel, string> = {
  beginner:
    "Use short simple sentences and basic vocabulary. Limit vocabulary to the 1000 most common words in the target language. Avoid idioms, slang, and complex expressions. Give detailed corrections with a full explanation and a clear example.",
  intermediate:
    "Use natural conversational pace and everyday vocabulary including common idioms. Correct errors concisely with a brief reason and one example. Ask open questions that require a full sentence response.",
  advanced:
    "Use full natural speed, complex structures, and idiomatic expressions. Keep corrections brief — one clause only. Challenge the user with abstract topics, hypotheticals, and nuanced questions.",
};

const DB_NAME = "fvt_prompt_db";
const STORE_NAME = "prompts";
const PROMPT_KEY = "custom_system_prompt";
const LEVEL_KEY = "conversation_level";

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveCustomPrompt(prompt: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(prompt, PROMPT_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function loadCustomPrompt(): Promise<string | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).get(PROMPT_KEY);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

export async function clearCustomPrompt(): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).delete(PROMPT_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export function getSavedLevel(): ConversationLevel {
  try {
    const v = localStorage.getItem("fvt_level");
    if (v === "beginner" || v === "intermediate" || v === "advanced") return v;
  } catch {}
  return "intermediate";
}

export function saveLevel(level: ConversationLevel): void {
  localStorage.setItem("fvt_level", level);
}

/** Strip parenthetical session references like "(untested session 2024-01-15)" */
function cleanWeakSpot(text: string): string {
  return sanitizeKbString(text.replace(/\s*\(untested session \d{4}-\d{2}-\d{2}\)/gi, "").trim());
}

/** Sanitize a KB-sourced string: truncate length and strip prompt-injection markers */
function sanitizeKbString(text: string, maxLen = 200): string {
  return text
    .slice(0, maxLen)
    .replace(/[«»[\]{}<>]/g, "")
    .trim();
}

/** Section headers. ROLE is user-editable prose (the personality/behavior of
 * the assistant). LANGUAGE is data-driven (built fresh from the dropdown
 * every chat turn). They're split into two sections precisely so the user
 * can customize ROLE without affecting the language and vice versa. */
const ROLE_HEADER = "ROLE";
const LANGUAGE_HEADER = "LANGUAGE";

/** Default content for the ROLE section. User-editable; saved as-is. */
const DEFAULT_ROLE_CONTENT =
  "You are a friendly conversation partner. Catch genuine grammatical errors, but never sacrifice natural conversation flow to over-correct.";

/** Section headers whose content is generated from data (settings + KB), not
 * from the user's saved prompt. These get stripped from saved/loaded prompts
 * and re-attached at chat time, so the data source (dropdown / KB file) is
 * always the single source of truth. ROLE is NOT in this list — it's
 * user-editable. */
const DYNAMIC_SECTION_HEADERS = [
  LANGUAGE_HEADER,
  "NAME USAGE",
  "TARGET STRUCTURES",
  "KNOWN WEAK SPOTS",
  "ADDITIONAL INSTRUCTIONS",
];

/** Build the LANGUAGE section from the current (or specified) language. The
 * language word is interpolated from the dropdown setting via
 * `getLanguageConfig().promptLang`; no regex involvement.
 *
 * The wording is intentionally explicit about *every part of the response*
 * because the surrounding system prompt is written in English. Without the
 * exhaustive list, the model occasionally interprets correction reasons or
 * explanations as "meta" content allowed in English. See §13.8. */
export function buildLanguageSection(langCode?: LanguageCode): string {
  const lang = langCode ? getLanguageConfig(langCode) : getEffectiveLanguage();
  return (
    `${LANGUAGE_HEADER}\n\n` +
    `Conduct the entire conversation in ${lang.promptLang}. EVERY part of your response — the reply, any corrected phrase, the reason given for a correction, examples, and any explanation — must be in ${lang.promptLang}. Never switch to English or any other language for any part of any response, even when explaining a grammar point.`
  );
}

/** One-time migration: prompts saved before v3.0 used a combined
 * "ROLE AND LANGUAGE" section. Rename the header to plain "ROLE" so the new
 * pipeline picks it up as user-editable. The legacy language word may still
 * be embedded in the user's prose; the freshly-prepended LANGUAGE section
 * will be authoritative anyway, and any motivated user can clean it up. */
function migrateLegacyRoleHeader(prompt: string): string {
  return prompt
    .split("\n\n\n")
    .map((section) =>
      section.startsWith("ROLE AND LANGUAGE\n\n")
        ? section.replace("ROLE AND LANGUAGE\n\n", `${ROLE_HEADER}\n\n`)
        : section,
    )
    .join("\n\n\n");
}

/** Remove dynamic sections (LANGUAGE + KB sections) from a prompt so the
 * saved prompt never carries stale data across reloads — those sections are
 * rebuilt fresh at chat time. ROLE is intentionally preserved because it's
 * user-editable. The legacy function name is retained for existing callers. */
export function stripKbSections(prompt: string): string {
  return prompt
    .split("\n\n\n")
    .filter((section) => {
      const firstLine = section.split("\n")[0].trim();
      return !DYNAMIC_SECTION_HEADERS.includes(firstLine);
    })
    .join("\n\n\n");
}

/** Build the editable base system prompt — no KB content, no user-specific data. */
export function buildBaseSystemPrompt(level?: ConversationLevel): string {
  const lvl = level ?? getSavedLevel();

  const sections: string[] = [];

  sections.push(`${ROLE_HEADER}\n\n${DEFAULT_ROLE_CONTENT}`);
  sections.push(buildLanguageSection());

  sections.push(
    "WHEN TO CORRECT\n\n" +
      `The user input is a speech transcript. Punctuation, capitalization, and accents are added by the transcription engine — they are NOT user choices and must never be treated as errors.\n\n` +
      `Do not correct: punctuation (including missing or wrong periods, commas, question marks), capitalization, accents, word choice, vocabulary, tone, register, style, or informal/colloquial expressions. If only these are "off", the sentence is fully correct — reply to the meaning with no correction.\n\n` +
      `Correct only objective grammatical errors: wrong verb form or tense, wrong auxiliary, missing reflexive pronoun, wrong agreement, wrong preposition.\n\n` +
      `When in doubt, do not correct. A false correction destroys trust faster than a missed error.`,
  );

  sections.push(
    "HOW TO CORRECT\n\n" +
      `When an error is present, open with: "[corrected phrase]" — [one-sentence reason]. [One short example.] Then continue naturally. No preamble — the response must begin with the opening straight double quote. All three of corrected phrase, reason, and example must be in the conversation's language — never in English or in the language these instructions are written in.\n\n` +
      `If the sentence is correct: do not acknowledge it in any way. Never praise the user's phrasing, never confirm it is correct, never say things like "yes, that's right", "well said", "perfect", or any similar validation. Treat the input as invisible — respond only to its meaning, as a native speaker would in a normal conversation.\n\n` +
      `On multiple errors, correct only the most fundamental one. Priority: verb form/tense > auxiliary > reflexive pronoun > agreement > preposition.`,
  );

  sections.push(
    "CONVERSATION STYLE\n\n" +
      `You are a friendly native speaker in casual conversation, not a teacher. Keep responses to 2–3 sentences. Vary topics: daily life, plans, opinions, stories, hypotheticals. Never mention grammar, weak spots, learning profiles, or that you have any information about the user.`,
  );

  sections.push("CONVERSATION LEVEL\n\n" + LEVEL_INSTRUCTIONS[lvl]);

  return sections.join("\n\n\n");
}

/** Caps on KB item counts to bound prompt size as a KB grows. */
const MAX_DUE_TOPICS = 8;
const MAX_WEAK_SPOTS = 12;

/** Build the KB-driven addendum to append after the base prompt at chat time. Empty string if nothing applies. */
export function buildKbAddendum(): string {
  const lang = getEffectiveLanguage();

  let userName = "";
  try {
    const raw = localStorage.getItem("fvt_kb");
    if (raw) {
      const kb = JSON.parse(raw);
      if (kb.user) userName = sanitizeKbString(kb.user, 50);
    }
  } catch {}
  if (!userName) {
    try {
      const cfgRaw = localStorage.getItem("fvt_config");
      if (cfgRaw) {
        const cfg = JSON.parse(cfgRaw);
        if (cfg.userName) userName = sanitizeKbString(cfg.userName, 50);
      }
    } catch {}
  }

  let kbLangMatches = false;
  let dueTopicNames: string[] = [];
  let weakSpots: string[] = [];
  let kbInstructions = "";
  try {
    const raw = localStorage.getItem("fvt_kb");
    if (raw) {
      const kb = JSON.parse(raw);
      kbLangMatches = kb.language === lang.code;

      if (kbLangMatches && Array.isArray(kb.topics) && kb.topics.length > 0) {
        const today = new Date().toISOString().slice(0, 10);
        dueTopicNames = kb.topics
          .filter((t: any) => !t.next_review || t.next_review <= today)
          .map((t: any) => t.name)
          .filter(Boolean)
          .map((n: string) => sanitizeKbString(n, 100))
          .slice(0, MAX_DUE_TOPICS);
        weakSpots = kb.topics
          .flatMap((t: any) => t.weak_spots || [])
          .filter(Boolean)
          .map(cleanWeakSpot)
          .filter(Boolean)
          .slice(0, MAX_WEAK_SPOTS);
      }

      if (kb.instructions) kbInstructions = sanitizeKbString(kb.instructions, 500);
    }
  } catch {}

  // Order: stable sections (NAME, ADDITIONAL INSTRUCTIONS) before date-volatile ones (TARGETS, WEAK SPOTS)
  // so the cacheable prefix lives as long as possible across daily rotations.
  const sections: string[] = [];

  if (userName) {
    sections.push(
      "NAME USAGE\n\n" +
        `The user's name is ${userName}. Use it at most once every 8–10 exchanges, when natural. Never in corrections or routine follow-ups.`,
    );
  }

  if (kbInstructions) {
    sections.push("ADDITIONAL INSTRUCTIONS\n\n" + kbInstructions);
  }

  if (kbLangMatches && dueTopicNames.length > 0) {
    const bullets = dueTopicNames.map((n) => `- ${n}`).join("\n");
    sections.push(
      "TARGET STRUCTURES\n\n" +
        `Steer questions so the user naturally produces these structures. Never name them explicitly.\n\n${bullets}`,
    );
  }

  if (kbLangMatches && weakSpots.length > 0) {
    const bullets = weakSpots.map((w) => `- ${w}`).join("\n");
    sections.push(
      "KNOWN WEAK SPOTS\n\n" +
        `Watch for errors on these points. On a mistake, correct briefly by rephrasing, then move on. Never reveal these are tracked.\n\n${bullets}`,
    );
  }

  return sections.join("\n\n\n");
}

/** Compose the final system prompt at chat time.
 *
 * The saved prompt owns the user-editable sections (ROLE, WHEN TO CORRECT,
 * HOW TO CORRECT, CONVERSATION STYLE, CONVERSATION LEVEL — and anything else
 * the user adds). The data-driven sections (LANGUAGE, KB content) are
 * stripped from whatever was loaded and rebuilt fresh from the current
 * dropdown / KB file. LANGUAGE is inserted directly after ROLE; the KB
 * addendum is inserted just before CONVERSATION LEVEL so level stays last.
 *
 * The dropdown is the single source of truth for language — no regex
 * pattern matching on prose, no chance of staleness in the saved prompt. */
export function composeFinalPrompt(base: string): string {
  const migrated = migrateLegacyRoleHeader(base);
  const cleanedBase = stripKbSections(migrated).trim();
  const languageSection = buildLanguageSection();
  const addendum = buildKbAddendum();

  const sections = cleanedBase ? cleanedBase.split("\n\n\n") : [];

  const result: string[] = [];
  let languageInserted = false;

  for (const section of sections) {
    const header = section.split("\n")[0].trim();
    if (header === "CONVERSATION LEVEL" && addendum) {
      result.push(addendum);
    }
    result.push(section);
    if (header === ROLE_HEADER && !languageInserted) {
      result.push(languageSection);
      languageInserted = true;
    }
  }

  // Fallback if the saved base lacks a ROLE section entirely: prepend the
  // default ROLE so LANGUAGE has its anchor point.
  if (!languageInserted) {
    result.unshift(`${ROLE_HEADER}\n\n${DEFAULT_ROLE_CONTENT}`, languageSection);
  }

  // Fallback if there's no CONVERSATION LEVEL but a KB addendum needs a home.
  const hasLevel = result.some((s) => s.split("\n")[0].trim() === "CONVERSATION LEVEL");
  if (!hasLevel && addendum) result.push(addendum);

  return result.join("\n\n\n");
}

/** Replace the CONVERSATION LEVEL section in a prompt string */
export function replaceLevelInPrompt(prompt: string, level: ConversationLevel): string {
  const regex = /CONVERSATION LEVEL\n\n.+/;
  const replacement = `CONVERSATION LEVEL\n\n${LEVEL_INSTRUCTIONS[level]}`;
  if (regex.test(prompt)) {
    return prompt.replace(regex, replacement);
  }
  return prompt;
}

/** Replace the LANGUAGE section in a prompt string. Strips any existing
 * LANGUAGE section (by header match, not regex on prose) and inserts a
 * freshly-built one directly after ROLE. Used by the settings page to keep
 * the textarea preview in sync with the dropdown. */
export function replaceLanguageInPrompt(prompt: string, langCode: LanguageCode): string {
  const migrated = migrateLegacyRoleHeader(prompt);
  const fresh = buildLanguageSection(langCode);
  const sections = migrated.split("\n\n\n").filter((s) => {
    return s.split("\n")[0].trim() !== LANGUAGE_HEADER;
  });

  // Insert LANGUAGE right after ROLE; if ROLE is missing, prepend ROLE + LANGUAGE.
  const result: string[] = [];
  let inserted = false;
  for (const section of sections) {
    result.push(section);
    if (section.split("\n")[0].trim() === ROLE_HEADER && !inserted) {
      result.push(fresh);
      inserted = true;
    }
  }
  if (!inserted) {
    result.unshift(`${ROLE_HEADER}\n\n${DEFAULT_ROLE_CONTENT}`, fresh);
  }
  return result.join("\n\n\n");
}
