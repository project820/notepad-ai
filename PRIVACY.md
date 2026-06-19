# Privacy

Notepad AI is a local-first desktop app. This document summarizes what it stores
on your machine and what leaves it.

## Data stored locally (in the app's userData directory)

- **Encrypted API key store** — Claude / OpenRouter API keys, only when
  `safeStorage` encryption is available. Otherwise keys live in memory for the
  session and are not written to disk.
- **Encrypted ChatGPT OAuth store** (`codex-auth.bin`) — only when `safeStorage`
  is available; otherwise tokens are memory-only for the session.
- **`session.json`** — crash-recovery snapshot (current document text, path,
  view mode, and unified-chat history) so an unexpected quit can be recovered.
- **Prompt-assembly files** when you use them — `Owner.md`, `systemlaw.md`,
  and project wizard state (`project-wizard-state.json`).
- **Preferences** (theme, font size, locale, selected model, style) in the
  renderer's local storage.

These files stay on your computer. The app does not run telemetry or analytics.

## Data that leaves your machine

- **Only when you use AI features.** When you send a message in the unified
  chat, use Block AI, or run the project wizard with AI, the app sends your
  prompt and the relevant document excerpt to the **AI provider you selected**
  (ChatGPT/OpenAI, Anthropic Claude, or OpenRouter) over HTTPS.
- No document content is sent anywhere unless you trigger an AI action.
- Network requests for authentication go to the selected provider's endpoints.

## Secrets

- Secrets are never written as plaintext (see [SECURITY.md](./SECURITY.md)).
- Secrets are never exposed to the renderer; only the last 4 characters of a
  saved key are shown for identification.

## Clearing data

Quitting and deleting the app's userData directory removes all locally stored
data. Signing out removes the stored OAuth tokens; removing a key in settings
deletes that provider's stored key.
