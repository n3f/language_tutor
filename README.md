# language_tutor

A workspace for AI-powered language-learning tooling. Each subfolder is a self-contained subproject; pick one and follow its own README.

## Subprojects

| Folder | What it is |
|---|---|
| [`grammar_practice/`](./grammar_practice/) | A personal Claude-powered language tutor that runs on two files — a `CLAUDE.md` operating manual and a `knowledge_base/learner.json` profile. Uses the **SM-2 spaced-repetition algorithm** (the one behind Anki) to schedule reviews, tracks granular weak spots per topic across sessions, and works for any language. Designed for Claude Desktop's Cowork mode (or any AI client with local file read/write). See its [readme](./grammar_practice/readme.md) for setup. |
| [`speech_practice/`](./speech_practice/) | **Causons** — a browser-based voice-first language tutor. Click on the mic, speak in your target language, and get a natural reply with gentle grammar corrections. Twelve supported languages, BYO Groq + OpenAI keys, zero backend. Reads the same `learner.json` shape produced by `grammar_practice/` to personalize conversations. See its [README](./speech_practice/README.md) for setup and deployment, and [ARCHITECTURE.md](./speech_practice/ARCHITECTURE.md) for the design rationale and bug postmortems.

You can use the already implemented web app [here](https://language-speech-practice.alshelaev-e3d.workers.dev/) – no data are stored or sent anywhere. |
