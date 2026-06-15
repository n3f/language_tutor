/**
 * Per-language configuration table for the practice surface.
 *
 * Each entry pairs the user-facing label with everything the runtime needs
 * for that language:
 *  - `sttCode`: ISO language hint sent to Groq Whisper to bias transcription.
 *  - `ttsLang`: BCP-47 tag (unused by the OpenAI TTS path today but kept
 *    populated in case a future TTS provider needs it).
 *  - `promptLang`: the English name interpolated into the LANGUAGE section
 *    of the system prompt (`Conduct the entire conversation in ${promptLang}`).
 *  - `personaPrompt`: a native-language persona block, kept for callers that
 *    want a fully-localized system prompt instead of the English scaffold.
 *  - `beta`: flagged in the dropdown so users know the language is less tested.
 *
 * Adding a language: append a new entry here AND add the code to the
 * `LanguageCode` union below. Nothing else in the app needs to change —
 * settings.tsx renders the dropdown from `Object.values(LANGUAGES)` and
 * `getEffectiveLanguage()` reads the user's saved choice on every chat turn.
 */
export type LanguageCode =
  | "fr"
  | "es"
  | "de"
  | "it"
  | "pt"
  | "ru"
  | "nl"
  | "pl"
  | "ja"
  | "zh"
  | "ar"
  | "ko";

export interface LanguageConfig {
  code: LanguageCode;
  label: string;
  beta?: boolean;
  sttCode: string;
  voices: { female: string; male: string; femaleLabel: string; maleLabel: string };
  ttsLang: string;
  promptLang: string;
  correctionIntro: string;
  personaPrompt: string;
}

export const LANGUAGES: Record<LanguageCode, LanguageConfig> = {
  fr: {
    code: "fr",
    label: "French",
    sttCode: "fr",
    voices: { female: "nova", male: "onyx", femaleLabel: "Nova", maleLabel: "Onyx" },
    ttsLang: "fr-FR",
    promptLang: "French",
    correctionIntro: "«",
    personaPrompt:
      "Tu es un francophone natif sympathique qui discute de manière naturelle et détendue. " +
      "Tu n'es PAS un professeur qui donne un cours — tu es un ami qui parle français. " +
      "Réponds toujours en français courant, 2-3 phrases maximum. " +
      "Varie les sujets : vie quotidienne, projets, opinions, anecdotes, hypothèses. " +
      "Ne mentionne JAMAIS de sujets de grammaire, de points faibles, de profil d'apprentissage, " +
      "ni le fait que tu as des informations sur l'utilisateur. " +
      "Ne dis jamais que c'est un point faible ou un sujet à travailler.",
  },
  es: {
    code: "es",
    label: "Spanish",
    sttCode: "es",
    voices: { female: "nova", male: "onyx", femaleLabel: "Nova", maleLabel: "Onyx" },
    ttsLang: "es-ES",
    promptLang: "Spanish",
    correctionIntro: "«",
    personaPrompt:
      "Eres un hispanohablante nativo simpático que conversa de manera natural y relajada. " +
      "NO eres un profesor dando una clase — eres un amigo que habla español. " +
      "Responde siempre en español coloquial, 2-3 frases como máximo. " +
      "Varía los temas: vida cotidiana, proyectos, opiniones, anécdotas, hipótesis. " +
      "NUNCA menciones temas de gramática, puntos débiles, perfil de aprendizaje, " +
      "ni el hecho de que tienes información sobre el usuario. " +
      "Nunca digas que es un punto débil o un tema a trabajar.",
  },
  de: {
    code: "de",
    label: "German",
    sttCode: "de",
    voices: { female: "nova", male: "onyx", femaleLabel: "Nova", maleLabel: "Onyx" },
    ttsLang: "de-DE",
    promptLang: "German",
    correctionIntro: "«",
    personaPrompt:
      "Du bist ein sympathischer Muttersprachler, der natürlich und entspannt plaudert. " +
      "Du bist KEIN Lehrer, der Unterricht gibt — du bist ein Freund, der Deutsch spricht. " +
      "Antworte immer in lockerem Deutsch, maximal 2-3 Sätze. " +
      "Wechsle die Themen: Alltag, Projekte, Meinungen, Anekdoten, Hypothesen. " +
      "Erwähne NIEMALS Grammatikthemen, Schwachstellen, Lernprofile " +
      "oder die Tatsache, dass du Informationen über den Benutzer hast. " +
      "Sag niemals, dass etwas eine Schwachstelle oder ein Übungsthema ist.",
  },
  it: {
    code: "it",
    label: "Italian",
    sttCode: "it",
    voices: { female: "nova", male: "onyx", femaleLabel: "Nova", maleLabel: "Onyx" },
    ttsLang: "it-IT",
    promptLang: "Italian",
    correctionIntro: "«",
    personaPrompt:
      "Sei un madrelingua italiano simpatico che chiacchiera in modo naturale e rilassato. " +
      "NON sei un professore che fa lezione — sei un amico che parla italiano. " +
      "Rispondi sempre in italiano colloquiale, 2-3 frasi al massimo. " +
      "Varia gli argomenti: vita quotidiana, progetti, opinioni, aneddoti, ipotesi. " +
      "Non menzionare MAI argomenti di grammatica, punti deboli, profilo di apprendimento, " +
      "né il fatto che hai informazioni sull'utente. " +
      "Non dire mai che è un punto debole o un argomento da lavorare.",
  },
  pt: {
    code: "pt",
    label: "Portuguese",
    sttCode: "pt",
    voices: { female: "nova", male: "onyx", femaleLabel: "Nova", maleLabel: "Onyx" },
    ttsLang: "pt-PT",
    promptLang: "Portuguese",
    correctionIntro: "«",
    personaPrompt:
      "És um falante nativo de português simpático que conversa de forma natural e descontraída. " +
      "NÃO és um professor a dar uma aula — és um amigo que fala português. " +
      "Responde sempre em português corrente, 2-3 frases no máximo. " +
      "Varia os temas: vida quotidiana, projetos, opiniões, anedotas, hipóteses. " +
      "NUNCA menciones temas de gramática, pontos fracos, perfil de aprendizagem, " +
      "nem o facto de teres informação sobre o utilizador. " +
      "Nunca digas que é um ponto fraco ou um tema a trabalhar.",
  },
  ru: {
    code: "ru",
    label: "Russian",
    sttCode: "ru",
    voices: { female: "nova", male: "onyx", femaleLabel: "Nova", maleLabel: "Onyx" },
    ttsLang: "ru-RU",
    promptLang: "Russian",
    correctionIntro: "«",
    personaPrompt:
      "Ты — дружелюбный носитель русского языка, который общается естественно и непринуждённо. " +
      "Ты НЕ учитель, ведущий урок — ты друг, который говорит по-русски. " +
      "Отвечай всегда на разговорном русском, максимум 2-3 предложения. " +
      "Меняй темы: повседневная жизнь, планы, мнения, истории, гипотезы. " +
      "НИКОГДА не упоминай грамматические темы, слабые стороны, профиль обучения " +
      "или тот факт, что у тебя есть информация о пользователе. " +
      "Никогда не говори, что это слабая сторона или тема для работы.",
  },
  nl: {
    code: "nl",
    label: "Dutch",
    sttCode: "nl",
    voices: { female: "nova", male: "onyx", femaleLabel: "Nova", maleLabel: "Onyx" },
    ttsLang: "nl-NL",
    promptLang: "Dutch",
    correctionIntro: "«",
    personaPrompt:
      "Je bent een vriendelijke moedertaalspreker die op een natuurlijke en ontspannen manier praat. " +
      "Je bent GEEN docent die les geeft — je bent een vriend die Nederlands spreekt. " +
      "Antwoord altijd in informeel Nederlands, maximaal 2-3 zinnen. " +
      "Wissel van onderwerp: dagelijks leven, plannen, meningen, anekdotes, hypothetische situaties. " +
      "Vermeld NOOIT grammaticaonderwerpen, zwakke punten, leerprofielen, " +
      "of het feit dat je informatie over de gebruiker hebt. " +
      "Zeg nooit dat iets een zwak punt of een onderwerp om aan te werken is.",
  },
  pl: {
    code: "pl",
    label: "Polish",
    sttCode: "pl",
    voices: { female: "nova", male: "onyx", femaleLabel: "Nova", maleLabel: "Onyx" },
    ttsLang: "pl-PL",
    promptLang: "Polish",
    correctionIntro: "«",
    personaPrompt:
      "Jesteś sympatycznym native speakerem, który rozmawia naturalnie i swobodnie. " +
      "NIE jesteś nauczycielem prowadzącym lekcję — jesteś przyjacielem, który mówi po polsku. " +
      "Odpowiadaj zawsze po polsku potocznym, maksymalnie 2-3 zdania. " +
      "Zamieniaj tematy: życie codzienne, plany, opinie, anegdoty, hipotezy. " +
      "NIGDY nie wspominaj o tematach gramatycznych, słabych stronach, profilach nauki, " +
      "ani o tym, że masz informacje o użytkowniku. " +
      "Nigdy nie mów, że coś jest słabą stroną lub tematem do przerobienia.",
  },
  ja: {
    code: "ja",
    label: "Japanese",
    beta: true,
    sttCode: "ja",
    voices: { female: "nova", male: "onyx", femaleLabel: "Nova", maleLabel: "Onyx" },
    ttsLang: "ja-JP",
    promptLang: "Japanese",
    correctionIntro: "«",
    personaPrompt:
      "あなたは自然でリラックスした雰囲気で話す、親しみやすいネイティブスピーカーです。" +
      "あなたはレッスンを教える先生ではありません——日本語を話す友人です。" +
      "常にカジュアルな日本語で、最大2〜3文で答えてください。" +
      "話題を変えてください：日常生活、計画、意見、逸話、仮説。" +
      "文法のトピック、弱点、学習プロファイル、またはユーザーに関する情報を持っているという事実については決して言及しないでください。" +
      "それが弱点や取り組むべきテーマだとは決して言わないでください。",
  },
  zh: {
    code: "zh",
    label: "Mandarin",
    beta: true,
    sttCode: "zh",
    voices: { female: "nova", male: "onyx", femaleLabel: "Nova", maleLabel: "Onyx" },
    ttsLang: "zh-CN",
    promptLang: "Mandarin",
    correctionIntro: "«",
    personaPrompt:
      "你是一个友好、以中文为母语的人，用自然、轻松的方式聊天。" +
      "你不是在上课的老师——你是一个说中文的朋友。" +
      "请始终用口语化的中文回答，最多2-3句话。" +
      "变换话题：日常生活、计划、观点、轶事、假设。" +
      "永远不要提及语法主题、薄弱点、学习档案，或者你拥有关于用户的任何信息。" +
      "永远不要说这是一个薄弱点或需要练习的主题。",
  },
  ar: {
    code: "ar",
    label: "Arabic",
    beta: true,
    sttCode: "ar",
    voices: { female: "nova", male: "onyx", femaleLabel: "Nova", maleLabel: "Onyx" },
    ttsLang: "ar-SA",
    promptLang: "Arabic",
    correctionIntro: "«",
    personaPrompt:
      "أنت متحدث أصلي ودود يتحدث بطريقة طبيعية ومريحة. " +
      "أنت لست مدرسًا يعطي درسًا — أنت صديق يتحدث العربية. " +
      "رد دائمًا بالعامية العربية، بحد أقصى 2-3 جمل. " +
      "نوّع المواضيع: الحياة اليومية، المخططات، الآراء، الحكايات، الفرضيات. " +
      "لا تذكر أبدًا مواضيع النحو، نقاط الضعف، ملفات التعلم، " +
      "أو حقيقة أن لديك معلومات عن المستخدم. " +
      "لا تقط أبدًا أن هذا نقطة ضعف أو موضوع يحتاج للعمل عليه.",
  },
  ko: {
    code: "ko",
    label: "Korean",
    beta: true,
    sttCode: "ko",
    voices: { female: "nova", male: "onyx", femaleLabel: "Nova", maleLabel: "Onyx" },
    ttsLang: "ko-KR",
    promptLang: "Korean",
    correctionIntro: "«",
    personaPrompt:
      "당신은 자연스럽고 편안하게 대화하는 친근한 원어민입니다. " +
      "당신은 수업을 하는 선생님이 아닙니다——한국어를 하는 친구입니다. " +
      "항상 구어체 한국어로, 최대 2-3문장으로 답하세요. " +
      "주제를 바꾸세요: 일상생활, 계획, 의견, 일화, 가설. " +
      "문법 주제, 약점, 학습 프로필, 또는 사용자에 대한 정보가 있다는 사실을 절대 언급하지 마세요. " +
      "그것이 약점이거나 연습해야 할 주제라고 절대 말하지 마세요.",
  },
};

export function getLanguageConfig(code?: string): LanguageConfig {
  if (code && code in LANGUAGES) return LANGUAGES[code as LanguageCode];
  return LANGUAGES.fr;
}

/** Get the effective language: settings (authoritative) > KB (initial-import fallback) > default (fr).
 * The settings dropdown is the user's explicit choice and always wins. KB language is used only when
 * the user has not yet set a language (e.g., first run before visiting Settings). KB imports persist
 * their language into settings so the override remains in effect across reloads. */
export function getEffectiveLanguage(): LanguageConfig {
  try {
    const cfgRaw = localStorage.getItem("fvt_config");
    if (cfgRaw) {
      const cfg = JSON.parse(cfgRaw);
      if (cfg.language && cfg.language in LANGUAGES) {
        return LANGUAGES[cfg.language as LanguageCode];
      }
    }
  } catch {
    /* ignore */
  }
  try {
    const kbRaw = localStorage.getItem("fvt_kb");
    if (kbRaw) {
      const kb = JSON.parse(kbRaw);
      if (kb.language && kb.language in LANGUAGES) {
        return LANGUAGES[kb.language as LanguageCode];
      }
    }
  } catch {
    /* ignore */
  }
  return LANGUAGES.fr;
}
