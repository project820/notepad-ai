# Claude model-id verification (Bug B / PR #2)

This PR moves the curated Claude ids from the legacy `claude-sonnet-4-5` / `claude-opus-4-1`
to the current `claude-sonnet-4-6` / `claude-opus-4-8` (and keeps `claude-haiku-4-5`).

Because the app is **CLI-first** (`claude -p`, subscription — see `claude-composed.ts`), these
ids are exercised through the local `claude` CLI on the normal path; the Anthropic Messages
API is only the automatic fallback when the CLI is unavailable/fails, or for a BYO-key user
with no CLI installed.

## Reproducible smoke (recorded 2026-07-06, `claude` CLI 2.1.199)

Run locally to reproduce:

```
claude -p --output-format stream-json --model claude-opus-4-8   "say OK"   # → OK   (accepted directly)
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
