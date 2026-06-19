/**
 * block-ai-adapter.ts — Block AI surface adapter for the 7-layer prompt stack.
 *
 * Phase 1 of notepad-ai v1.1 "Prompt Stack Foundation".
 *
 * `buildBlockAiSystemPrompt` is the single call-site replacement for the
 * ad-hoc `SYSTEM_PROMPT` string used in `src/renderer/block-ai.ts`.
 *
 * ─── Toggle routing ──────────────────────────────────────────────────────────
 *
 * When `isPromptAssemblyEnabled()` returns `false` (the default):
 *   → Returns the v1.0 `BLOCK_AI_LEGACY_PROMPT` + quality directive, byte-
 *     identical to what the renderer used before v1.1.  No new code paths are
 *     entered; callers that have not opted in see zero behaviour change.
 *
 * When `isPromptAssemblyEnabled()` returns `true`:
 *   → Calls the injected `assembler` (defaults to `assemblePrompt`) with a
 *     full `AssemblyRequest` that maps every Block AI input to the correct
 *     layer slot in the 7-layer stack.
 *
 * ─── Testability ─────────────────────────────────────────────────────────────
 *
 * The `assembler` parameter is dependency-injected.  Tests pass a mock that
 * returns a predetermined string (e.g. fallback-only stack content) without
 * touching the real assembler.  Production code passes no second argument —
 * the default `assemblePrompt` is used.
 *
 * ─── Graceful fallback ───────────────────────────────────────────────────────
 *
 * Every code path in this module is null-safe and never throws:
 *   - Missing / empty `systemlawContent` → silently dropped by assembler.
 *   - Missing / empty `ownerContent`     → silently dropped by assembler.
 *   - Empty `qualityDirective`           → silently dropped by assembler.
 *   - Empty `fragment` / `instruction`   → silently dropped by assembler.
 *   - `assembler` returns ''             → '' propagated; caller may treat as
 *     "no system prompt" — this module never substitutes its own default.
 *
 * ─── Rollback safety ─────────────────────────────────────────────────────────
 *
 * This module is purely additive.  `block-ai.ts` continues to use its inline
 * `SYSTEM_PROMPT` constant directly today (v1.0 path).  Once the feature toggle
 * integration lands in a subsequent sub-AC, `block-ai.ts` will call this adapter
 * instead — at which point toggle-off reproduces the v1.0 path exactly, because
 * `BLOCK_AI_LEGACY_PROMPT` is exported from here and kept in sync.
 */

import { assemblePrompt, type AssemblyRequest, type AssembledPrompt } from './assemble';
import { isPromptAssemblyEnabled } from './toggle';

// ---------------------------------------------------------------------------
// Legacy v1.0 prompt (kept in sync with SYSTEM_PROMPT in block-ai.ts)
// ---------------------------------------------------------------------------

/**
 * The v1.0 Block AI system prompt, copied verbatim from
 * `src/renderer/block-ai.ts` `SYSTEM_PROMPT`.
 *
 * Exported so:
 *   1. This adapter can construct the legacy path without an import cycle.
 *   2. Tests can assert the legacy path uses exactly this string.
 *   3. The v1.1 path injects this as Layer 3 (surface) of the 7-layer stack.
 *
 * MUST be kept in sync with `SYSTEM_PROMPT` in `block-ai.ts` until the
 * renderer is refactored to import `BLOCK_AI_LEGACY_PROMPT` from here.
 */
export const BLOCK_AI_LEGACY_PROMPT =
  `You are a focused text-rewriting assistant inside a Markdown editor.\n` +
  `The user has selected a fragment of text and given an instruction.\n` +
  `Produce EXACTLY 3 alternative rewrites of the fragment. Rules:\n` +
  `- Output ONLY the 3 alternatives.\n` +
  `- Separate each alternative with a line containing exactly three dashes: ---\n` +
  `- Preserve the markdown semantic of the selection (heading stays heading, list stays list).\n` +
  `- Keep length in the same ballpark as the original unless the instruction asks otherwise.\n` +
  `- Match the user's language (Korean or English).\n` +
  `- No numbering, no commentary, no preamble.`;

// ---------------------------------------------------------------------------
// Public parameter type
// ---------------------------------------------------------------------------

/**
 * All inputs needed to build the Block AI system prompt.
 *
 * Every field is optional at the type level — missing / empty values are
 * silently dropped from the assembled output rather than causing errors.
 */
export type BlockAiPromptParams = {
  /**
   * Pre-loaded content of `userData/systemlaw.md` (Layer 0).
   * Pass `''` (or omit) when the file is absent or the toggle is off — the
   * layer is silently excluded from the assembled output.
   */
  systemlawContent?: string;

  /**
   * Pre-loaded content of `userData/Owner.md` (Layer 1).
   * Pass `''` (or omit) when the file is absent — silently excluded.
   */
  ownerContent?: string;

  /**
   * Quality-dial directive string (Layer 4).
   * E.g. `"Write at an elementary school reading level."`.
   * Omit or pass `''` to exclude.
   */
  qualityDirective?: string;

  /**
   * The selected text fragment (Layer 5 / document context).
   * Cap applied by the caller before passing here.
   * Omit or pass `''` to exclude.
   */
  fragment?: string;

  /**
   * The user's specific instruction text (Layer 6).
   * E.g. `"Rewrite this as a bullet list."`.
   * Omit or pass `''` to exclude.
   */
  instruction?: string;
};

// ---------------------------------------------------------------------------
// Core adapter function
// ---------------------------------------------------------------------------

/**
 * Build the complete system-prompt string for a Block AI (F3) request.
 *
 * Routing:
 *   - Toggle OFF (default) → legacy v1.0 path: `BLOCK_AI_LEGACY_PROMPT` +
 *     quality directive joined by `\n\n`.  Byte-identical to v1.0 behaviour.
 *   - Toggle ON            → v1.1 path: `assembler` called with a full
 *     7-layer `AssemblyRequest`.
 *
 * @param params    - Block AI prompt inputs (all optional; missing → dropped).
 * @param assembler - Prompt assembler to use when toggle is ON.  Defaults to
 *                   the real `assemblePrompt`; pass a mock in tests.
 * @returns          The assembled system-prompt string, or `''` when all
 *                   inputs are blank (caller may treat as "no system prompt").
 *
 * @example
 * // Production (no second arg — uses real assemblePrompt)
 * const sysPrompt = buildBlockAiSystemPrompt({
 *   systemlawContent: await readSystemlaw(userDataPath),
 *   ownerContent:     await readOwner(userDataPath),
 *   qualityDirective: qualityDirective(quality),
 *   fragment:         selectedText,
 *   instruction:      userInstruction,
 * });
 *
 * @example
 * // Test (inject mock assembler)
 * const sysPrompt = buildBlockAiSystemPrompt(params, mockAssembler);
 */
export function buildBlockAiSystemPrompt(
  params: BlockAiPromptParams,
  assembler: (req: AssemblyRequest) => AssembledPrompt = assemblePrompt,
): AssembledPrompt {
  // ── Toggle-off: v1.0 legacy path ──────────────────────────────────────────
  if (!isPromptAssemblyEnabled()) {
    // Reconstruct exactly what block-ai.ts does today:
    //   `${SYSTEM_PROMPT}\n\n${qualityDirective(deps.getQuality())}`
    // Quality directive may be empty (e.g. when quality is 'none') — in that
    // case we return just the BLOCK_AI_LEGACY_PROMPT without the trailing \n\n.
    const parts: string[] = [BLOCK_AI_LEGACY_PROMPT];
    const qd = (params.qualityDirective ?? '').trim();
    if (qd.length > 0) parts.push(qd);
    return parts.join('\n\n');
  }

  // ── Toggle-on: v1.1 seven-layer assembly path ────────────────────────────
  const req: AssemblyRequest = {
    surface:          'BlockAI',
    systemlawContent: params.systemlawContent  ?? '',
    ownerContent:     params.ownerContent      ?? '',
    // Layer 3 — surface-specific instructions (the Block AI rewrite rules)
    surfacePrompt:    BLOCK_AI_LEGACY_PROMPT,
    qualityDirective: params.qualityDirective  ?? '',
    documentText:     params.fragment          ?? '',
    userInstruction:  params.instruction       ?? '',
  };

  return assembler(req);
}
