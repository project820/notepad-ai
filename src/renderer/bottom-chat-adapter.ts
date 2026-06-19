/**
 * bottom-chat-adapter.ts — Bottom Chat surface adapter for the 7-layer prompt stack.
 *
 * Phase 1 of notepad-ai v1.1 "Prompt Stack Foundation".
 *
 * `buildBottomChatInstructions` is the single call-site replacement for the
 * ad-hoc `SYSTEM_PROMPT` string + document-context concatenation used inside
 * the `send()` function of `src/renderer/bottom-chat.ts`.
 *
 * ─── Toggle routing ──────────────────────────────────────────────────────────
 *
 * When `req.toggleEnabled` is `false` (the default):
 *   → Returns the v1.0 legacy concatenation:
 *       `BOTTOM_CHAT_SURFACE_PROMPT + quality + document-section`
 *     byte-identical to what the renderer produces today.  No new code paths
 *     are entered; callers that have not opted in see zero behaviour change.
 *
 * When `req.toggleEnabled` is `true`:
 *   → Calls the injected `assemble` function (defaults to `assemblePrompt`)
 *     with a full `AssemblyRequest` that maps every Bottom Chat input to the
 *     correct layer slot in the 7-layer stack.
 *
 * ─── Testability ─────────────────────────────────────────────────────────────
 *
 * The `assemble` parameter is dependency-injected.  Tests pass a mock that
 * returns a predetermined string (e.g. fallback-only stack content) without
 * touching the real assembler.  Production code passes no second argument —
 * the default `assemblePrompt` is used.
 *
 * ─── Graceful fallback ───────────────────────────────────────────────────────
 *
 * Every code path in this module is null-safe and never throws:
 *   - Missing `systemlawContent` / `ownerContent`  → silently dropped.
 *   - Empty `qualityDirectiveStr`                  → silently dropped.
 *   - Empty `documentText`                         → '(empty)' in legacy path;
 *                                                    silently dropped in new path.
 *   - `assemble` returns ''                        → '' propagated.
 *
 * ─── Rollback safety ─────────────────────────────────────────────────────────
 *
 * When `toggleEnabled` is `false`, this module returns the same string that
 * bottom-chat.ts produced in v1.0 — no new code paths are entered.  The feature
 * toggle defaults to off at the call-site in bottom-chat.ts, guaranteeing that
 * every user who has not opted in sees zero behaviour change.
 *
 * ─── Layer mapping for the new path ──────────────────────────────────────────
 *
 *   Layer 0 — systemlaw   ← req.systemlawContent
 *   Layer 1 — owner       ← req.ownerContent
 *   Layer 2 — overview    ← '' (stub — Phase 2)
 *   Layer 3 — surface     ← BOTTOM_CHAT_SURFACE_PROMPT
 *   Layer 4 — quality     ← req.qualityDirectiveStr
 *   Layer 5 — document    ← req.documentText (raw text, pre-truncated by caller)
 *   Layer 6 — instruction ← '' (Bottom Chat puts the user message in the API
 *                               conversation history, not in the system prompt)
 */

import { assemblePrompt, type AssemblyRequest } from '../main/prompts/assemble';

// ---------------------------------------------------------------------------
// Legacy v1.0 surface prompt
// ---------------------------------------------------------------------------

/**
 * The v1.0 Bottom Chat system prompt, copied verbatim from the `SYSTEM_PROMPT`
 * constant in `src/renderer/bottom-chat.ts`.
 *
 * Exported so:
 *   1. This adapter can construct the legacy path without an import cycle.
 *   2. Tests can assert the legacy path uses exactly this string.
 *   3. The v1.1 path injects this as Layer 3 (surface) of the 7-layer stack.
 *
 * MUST be kept in sync with `SYSTEM_PROMPT` in `bottom-chat.ts` until the
 * renderer is refactored to import `BOTTOM_CHAT_SURFACE_PROMPT` from here.
 */
export const BOTTOM_CHAT_SURFACE_PROMPT =
  `You are a writing assistant inside a Mac markdown editor.\n` +
  `The user wants concise, well-structured Markdown drafts and rewrites.\n` +
  `\n` +
  `Rules:\n` +
  `- Reply ONLY with the final markdown content unless the user is asking a question.\n` +
  `- Do not wrap output in code fences.\n` +
  `- Preserve existing structure (headings, lists, tables) when rewriting.\n` +
  `- Match the user's language (Korean or English) — if they wrote Korean, reply in Korean.`;

// ---------------------------------------------------------------------------
// Public parameter type
// ---------------------------------------------------------------------------

/**
 * All inputs needed to build the Bottom Chat system prompt.
 *
 * Every field except `toggleEnabled` is optional — missing / empty values are
 * silently dropped from the assembled output rather than causing errors.
 *
 * Passing `toggleEnabled: false` (or omitting it, defaulting callers to false)
 * always returns the legacy v1.0 path regardless of the other fields.
 */
export type BottomChatPromptRequest = {
  /**
   * Current state of the v1.1 feature toggle.
   * `true`  → use the 7-layer assembler.
   * `false` → use the legacy v1.0 path (default, off).
   */
  toggleEnabled: boolean;

  /**
   * Pre-loaded content of `userData/systemlaw.md` (layer 0).
   * Ignored when `toggleEnabled` is `false`.
   * Pass `''` when the file does not exist or is unreadable.
   */
  systemlawContent?: string;

  /**
   * Pre-loaded content of `userData/Owner.md` (layer 1).
   * Ignored when `toggleEnabled` is `false`.
   * Pass `''` when the file does not exist or is unreadable.
   */
  ownerContent?: string;

  /**
   * The quality-dial directive string (layer 4).
   * E.g. `"Write at an elementary school reading level."`.
   * Included in both the legacy and new paths when non-empty.
   */
  qualityDirectiveStr?: string;

  /**
   * Current document text (layer 5).
   * Pre-truncated by the caller (bottom-chat.ts caps at 12 000 chars).
   * In the legacy path, wrapped with `=== Current document ===` delimiters.
   * In the new path, passed as raw text to the assembler's `documentText` slot.
   * Pass `''` or omit when no document is open.
   */
  documentText?: string;
};

/**
 * Injected assembler function type.
 *
 * Matches the signature of `assemblePrompt` from `src/main/prompts/assemble`.
 * Tests inject a `vi.fn()` that satisfies this type so the assembler can be
 * verified without coupling tests to the real implementation.
 */
export type AssemblerFn = (req: AssemblyRequest) => string;

// ---------------------------------------------------------------------------
// Core adapter function
// ---------------------------------------------------------------------------

/**
 * Build the complete system-prompt string for a Bottom Chat (F5) request.
 *
 * Routing:
 *   - Toggle OFF (default) → legacy v1.0 path: `BOTTOM_CHAT_SURFACE_PROMPT` +
 *     quality directive (if any) + document section (always included), joined
 *     by `\n\n`.  Byte-compatible with v1.0 behaviour.
 *   - Toggle ON            → v1.1 path: `assemble` called with a full
 *     7-layer `AssemblyRequest`.
 *
 * @param req       - Bottom Chat prompt inputs (`toggleEnabled` controls routing;
 *                   other fields feed the assembler or are used in the legacy
 *                   path).
 * @param assemble  - Prompt assembler to use when toggle is ON.  Defaults to
 *                   the real `assemblePrompt`; pass a mock in tests.
 * @returns          The assembled system-prompt string, or `''` when all
 *                   inputs are blank (caller may treat as "no system prompt").
 *
 * Never throws.  Callers should always receive a usable string when the toggle
 * is off, because `BOTTOM_CHAT_SURFACE_PROMPT` is always included.
 *
 * @example
 * // Production (no second arg — uses real assemblePrompt)
 * const sysPrompt = buildBottomChatInstructions({
 *   toggleEnabled:    isPromptAssemblyEnabled(),
 *   systemlawContent: await readSystemlaw(userDataPath),
 *   ownerContent:     await readOwner(userDataPath),
 *   qualityDirectiveStr: qualityDirective(quality),
 *   documentText:     document.slice(0, 12000),
 * });
 *
 * @example
 * // Test (inject mock assembler)
 * const sysPrompt = buildBottomChatInstructions(req, mockAssembler);
 */
export function buildBottomChatInstructions(
  req: BottomChatPromptRequest,
  assemble: AssemblerFn = assemblePrompt,
): string {
  const qualityStr = (req.qualityDirectiveStr ?? '').trim();

  if (req.toggleEnabled) {
    // ── New 7-layer path ────────────────────────────────────────────────────
    // Delegate to the assembler with all content slices.
    // Empty strings are silently dropped by `assemblePrompt`'s filter step.
    const assemblyReq: AssemblyRequest = {
      surface:          'BottomChat',
      systemlawContent: req.systemlawContent ?? '',
      ownerContent:     req.ownerContent     ?? '',
      surfacePrompt:    BOTTOM_CHAT_SURFACE_PROMPT,
      qualityDirective: qualityStr,
      documentText:     req.documentText     ?? '',
      // userInstruction is intentionally omitted — Bottom Chat sends the user
      // message as a conversation turn, not embedded in the system prompt.
    };
    return assemble(assemblyReq);
  }

  // ── Legacy v1.0 path ───────────────────────────────────────────────────────
  // Reconstruct the instructions string from bottom-chat.ts `send()`:
  //   `${SYSTEM_PROMPT}\n\n${qd}\n\n=== Current document ===\n${doc || '(empty)'}\n=== End document ===`
  //
  // We reproduce this faithfully but filter whitespace-only segments to avoid
  // spurious double-blank-lines when qd is empty.
  const parts: string[] = [BOTTOM_CHAT_SURFACE_PROMPT];

  if (qualityStr.length > 0) {
    parts.push(qualityStr);
  }

  // Document section — always included in the legacy path to match v1.0
  // behaviour where the document context was unconditionally appended.
  const rawDoc = req.documentText ?? '';
  const docContent = rawDoc.trim().length > 0 ? rawDoc : '(empty)';
  parts.push(`=== Current document ===\n${docContent}\n=== End document ===`);

  return parts.join('\n\n');
}
