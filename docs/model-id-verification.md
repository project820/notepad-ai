# Model ID verification
## Displayed cloud catalog (B4)

- **ChatGPT:** `gpt-5.6`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, and `gpt-5.5` are verified against OpenAI's latest-model documentation. `gpt-5.3-codex-spark` is displayable only when it appears in the authenticated `/models` response; it is intentionally absent from the fallback catalog.
- **Claude:** `claude-opus-4-8`, `claude-sonnet-5`, and `claude-haiku-4-5` are CLI-smoke-verified below. `claude-sonnet-4-6` remains accepted as a legacy selection but is not curated.
- **Grok:** `grok-4.5` is available through both the xAI API and Grok CLI. `grok-composer-2.5-fast` requires an xAI API key; CLI-only authentication lists `grok-4.5` only.

## Claude CLI verification

This record preserves the earlier verification of legacy Claude aliases and canonical CLI IDs.

Because the app is **CLI-first** (`claude -p`, subscription — see `claude-composed.ts`), these
ids are exercised through the local `claude` CLI on the normal path; the Anthropic Messages
API is only the automatic fallback when the CLI is unavailable/fails, or for a BYO-key user
with no CLI installed.

## Reproducible smoke (recorded 2026-07-06, `claude` CLI 2.1.199)

Run locally to reproduce:

```
claude -p --output-format stream-json --model claude-opus-4-8   "say OK"   # → OK   (accepted directly)
claude -p --output-format stream-json --model claude-sonnet-5   "say OK"   # → OK   (accepted directly; assistant record reports "model":"claude-sonnet-5"; verified 2026-07-06 app-style stdin+--verbose)
claude -p --output-format stream-json --model claude-sonnet-4-6 "say OK"   # → OK   (accepted directly)
claude -p --output-format stream-json --model claude-haiku-4-5  "say OK"   # → OK
claude -p --model claude-opus-4-1   "say OK"   # → OK, warns: "claude-opus-4-1 is automatically remapped to Opus 4.8 (the latest Opus)"
claude -p --model claude-sonnet-4-5 "say OK"   # → OK (legacy alias, auto-remapped)
```

Result: the current ids are accepted directly; the legacy ids are aliases the CLI auto-remaps
to the current ones. The prefs migration therefore moves persisted selections onto the
canonical id (safe direction).

## Remaining gate (human / CI — no API key in the build environment)

The **Anthropic Messages API** acceptance of `claude-opus-4-8` / `claude-sonnet-4-6` could not be
verified here (no `ANTHROPIC_API_KEY` available). This only matters for the API fallback / BYO-key
path. Before relying on that path, run once with a key:

```
curl https://api.anthropic.com/v1/messages -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "anthropic-version: 2023-06-01" -H "content-type: application/json" \
  -d '{"model":"claude-opus-4-8","max_tokens":16,"messages":[{"role":"user","content":"say OK"}]}'
```
