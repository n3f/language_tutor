# Setup Guide

This project started as a personal French conversation practice helper, hence the name and the Victor Hugo mascot. It was then expanded to cover more languages and enable fine-tuning of the conversation difficulty and the initial prompt. The overall goal of this project is to create a robust and budget-friendly personal language learning solution. This page describes everything that is needed to start using it.

## How the app works

Causons lets you practice spoken French, German, Spanish, Italian, Portuguese, Russian, Dutch and Polish, as well as Japanese, Mandarin, Arabic and Korean (although with a weaker model support) with an AI conversation partner. You speak into your microphone on your computer, the app transcribes your speech, generates a contextual response, and speaks it back to you.

The app is designed to work as a companion to the Claude KB-based language learning system (see the "KB-based learning system" below). If you have a knowledge base (KB) file from your study sessions, you can load it on the Settings page to personalize the AI's focus — it will target your due topics and known weak spots.

Without a KB file, the app works as a generic conversation partner.

## Getting your Groq API key

Groq provides the speech-to-text (Whisper) service and was identified as the easiest budget-friendly option for this case. You will need to obtain the Groq API key for this app to work. Here is how to do it:

1. Go to [console.groq.com](https://console.groq.com)
2. Sign up for a free account (Google or GitHub login works)
3. Navigate to **API Keys** in the left sidebar
4. Click **Create API Key** and copy it
5. Paste it into the setup screen in this app

> 💡 Groq's free tier is generous — speech-to-text costs ~$0.002/minute and the LLM is ~$0.59 per million tokens. A typical 30-minute session costs about $0.10.

## Getting your OpenAI API key

OpenAI powers both the conversation model (GPT-4o-mini) and the text-to-speech voice conversion and was identified as the best option from the model quality and price standpoint. You will need to obtain the OpenAI API key for this app to work. Here is how to do it:

1. Go to [platform.openai.com](https://platform.openai.com)
2. Sign up or log in
3. Open **API Keys** in the dashboard
4. Click **Create new secret key** and copy it
5. Paste it into Settings in this app

> 💡 GPT-4o-mini and tts-1 are inexpensive — a typical 30-minute session costs only a few cents.

## KB-based learning system

This system is very simple and runs on two files: a CLAUDE.md instruction set that tells the AI exactly how to behave, and a knowledge base file that tracks every grammar topic you study. For each topic, the JSON file stores when it was last reviewed, when it's next due, how many times it's been repeated, and a difficulty score (ease factor) — plus a list of specific weak spots observed in past sessions. At the start of each session the AI reads the JSON, identifies what's due for review, and runs exercises. At the end, it applies the SM-2 spaced repetition algorithm — a proven method used in tools like Anki — to recalculate each topic's next review date based on how well you performed: easy recall pushes the next review further out, poor recall resets it to the next day. The updated JSON is then written back to disk, so every session builds on the last.

The best way to advance your learning is to get a good grammar book, follow its program and post the screenshots of any exercises from it for the AI to validate and explain. You can also just chat with AI about any language topic and ask for explanations, and it will then be added to your knowledge base.

This approach requires an AI assistant that can automatically read from and write to the knowledge base JSON file in the local filesystem without manual intervention. Claude Cowork is the recommended environment, as it handles this natively. If Cowork is unavailable, the closest alternative is to use the GPT Filesystem MCP server with the ChatGPT Desktop app, which replicates local file access via MCP. Manus (manus.im) is another option — its "My Computer" desktop feature supports local file read/write and is model-agnostic. 

You can download the files [here](https://github.com/mamnunam/language_tutor) and ask AI to adjust it to your personal profile.

## Loading your Knowledge Base file

Your knowledge base (KB) is a JSON file created by the KB-based learning system (see above). It tracks your grammar topics, spaced repetition state, and specific weak spots.

**Chrome / Edge:** The app can access your file directly using the File System Access API. You'll grant access once and the app will auto-read it on each visit.

**Safari / Firefox:** You'll use the file picker to select your KB file. The app stores an encrypted copy. Re-pick the file after study sessions to sync updates.

Don't have a KB file? No problem — the app works as a general conversation partner without one.

## Practice tips

- Speak in your language of choice as much as possible — the AI will gently correct your errors in the same language
- Don't worry about perfection — the AI companion is patient and encouraging
- Sessions of 15–30 minutes work best for retention
- After studying with KB-based learning system, sync your KB file to update your focus topics
- Try switching between the Nova (female) and Onyx (male) voices in Settings to get used to different pronounciation patterns

## Privacy & security

Your data stays on your device:

- API keys and settings are stored only in your browser's localStorage
- Your KB file is also cached in localStorage
- Conversation transcripts are held in memory only — never saved
- Nothing is sent to any server except Groq and OpenAI for processing
- You can clear all data anytime from Settings
