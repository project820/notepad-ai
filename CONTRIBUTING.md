# Contributing to Notepad AI

Thanks for your interest. Notepad AI is a Korean-centric, Apple Silicon macOS
Markdown editor built on Electron + CodeMirror 6 + markdown-it.

## Prerequisites

- macOS on Apple Silicon (arm64)
- Node.js >= 22.12.0
- npm

## Install, build, test

```bash
npm install
npm run dev          # Electron + Vite HMR dev mode
npm run typecheck    # type-check main + renderer
npm run test         # unit/DOM tests (vitest)
npm run build        # build main + renderer
npm run preflight:tessdata # validate bundled offline OCR data
npm run build:dmg    # package a DMG into release/ (optional)
```

## No-secret policy

- Never commit API keys, tokens, `.env` files, or other secrets.
- Never expose secrets to the renderer process; the renderer may only receive
  non-secret metadata. See [SECURITY.md](./SECURITY.md).
- Do not add plaintext credential persistence. Use `safeStorage` or
  memory-only fallback.

## Design + conventions

- "MD is the source of truth": preview/table/typography edits must not corrupt
  the underlying Markdown.
- Follow the existing UI tokens/conventions (see `DESIGN.md` and
  `src/renderer/design-tokens.css`); reuse existing patterns rather than adding
  parallel ones.
- Keep user-facing strings in the i18n layer (`src/renderer/i18n.ts`).

## PR verification checklist

Before opening a PR, confirm all of the following pass:

- [ ] `npm run typecheck` is clean
- [ ] `npm run test` is green
- [ ] `npm run build` succeeds
- [ ] `npm run preflight:tessdata` confirms the bundled OCR data before packaging
- [ ] `npm run test:security-e2e` is green
- [ ] `npm run test:converter-e2e` is green
- [ ] `npm run test:html-export-direct` is green
- [ ] `npm run test:roundtrip-smoke` is green
- [ ] `npm run knip` exits cleanly
- [ ] `npm audit --omit=dev --audit-level=high` reports no high/critical
- [ ] no secrets, `.env`, or internal/local-only files are added
- [ ] new user-facing strings are localized, not hard-coded English

Keep changes surgical and focused; include tests for new behavior.
