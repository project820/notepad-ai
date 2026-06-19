# Security Policy

## Supported versions

Notepad AI is an early open-source project. Security fixes target the latest
release and `main`. Older builds are not maintained.

| Version | Supported |
|---------|-----------|
| latest (`main` / newest release) | ✅ |
| older releases | ❌ |

## Reporting a vulnerability

Please report security issues privately:

- Open a [GitHub Security Advisory](https://github.com/project820/notepad-ai/security/advisories/new), or
- Open a regular issue **without** sensitive details and ask a maintainer to
  open a private channel.

Do not include real API keys, tokens, or other secrets in a public issue.

## Secret-handling policy

Notepad AI follows a strict credential boundary:

1. The app never writes secrets or tokens as plaintext to disk.
2. Persistent secret storage is used **only** when Electron `safeStorage`
   encryption is available and succeeds (macOS Keychain-backed).
3. If `safeStorage` is unavailable, ChatGPT OAuth tokens and BYO API keys are
   kept in process memory for the current session only and are never persisted.
4. Environment variables are a read-only credential source, read in the main
   process only. The app never writes, generates, or mutates `.env` files.
5. The renderer never receives raw API keys, access tokens, refresh tokens, or
   ID tokens. Renderer-facing status carries only non-secret metadata
   (`signedIn`, `email`, `plan`, `connected`, `persisted`, `keyLast4`).
6. External URLs are opened only for `http:`, `https:`, and `mailto:` schemes.

Optional environment overrides (main process, read-only):

- `NOTEPAD_AI_OPENAI_ACCESS_TOKEN`
- `NOTEPAD_AI_OPENAI_REFRESH_TOKEN`
- `NOTEPAD_AI_CLAUDE_API_KEY`
- `NOTEPAD_AI_OPENROUTER_API_KEY`

## Dependency status

- Runtime dependencies: no known high/critical advisories
  (`npm audit --omit=dev --audit-level=high`).
- Build/dev tooling (Electron, Vite/esbuild, electron-builder/tar) carries
  advisories that require major breaking upgrades. These are tracked for a
  dedicated upgrade pass (Electron, Vite, and electron-builder majors) and do
  not affect the runtime audit gate above.

## Build authenticity

Releases are **unsigned** (no Apple Developer signing). Verify the DMG checksum
published in the release notes before installing, and only run builds you
obtained from the official Releases page or built yourself.
