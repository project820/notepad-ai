/**
 * block-ai-prompt-handler.ts
 *
 * Prompt-routing logic for the Block AI (F3) surface.
 *
 * Sub-AC 3.2 of notepad-ai v1.1 Phase 1 — Prompt Stack Foundation.
 *
 * `buildBlockAiInstructions` is the single routing point for Block AI's
 * system-prompt assembly.  It reads the feature toggle state from the
 * supplied request and dispatches to either:
 *
 *   • NEW PATH  (toggleEnabled = true)  — calls the injected `assemble`
 *     function with a fully-typed AssemblyRequest, including systemlaw and
 *     Owner content pre-loaded by the caller.
 *
 *   • LEGACY PATH (toggleEnabled = false) — concatenates the hard-coded
 *     v1.0 `BLOCK_AI_SURFACE_PROMPT` with the quality directive exactly as
 *     v1.0 did, producing a byte-identical result.
 *
 * ─── Rollback safety ─────────────────────────────────────────────────────────
 *
 * When `toggleEnabled` is `false` (the default in production), no new code
 * paths are entered.  The legacy instructions string is returned unchanged.
 * The new assembly path is only entered when the feature toggle is explicitly
 * ON — which defaults to off (see toggle.ts, PROMPT_ASSEMBLY_DEFAULT = false).
 *
 * ─── Testability ─────────────────────────────────────────────────────────────
 *
 * The `assemble` parameter defaults to the real `assemblePrompt` implementation.
 * Tests inject a `vi.fn()` mock so:
 *   • Toggle-on branch: the mock is called and its return value is used.
 *   • Toggle-off branch: the mock is NOT called; the legacy string is returned.
 *
 * ─── No side effects ─────────────────────────────────────────────────────────
 *
 * This module is a pure function.  No DOM access, no IPC, no module-level
 * state.  Safe to import in any test environment.
 *
 * ─── Layer mapping for the new path ──────────────────────────────────────────
 *
 *   Layer 0 — systemlaw   ← req.systemlawContent
 *   Layer 1 — owner       ← req.ownerContent
 *   Layer 2 — overview    ← '' (stub — Phase 2)
 *   Layer 3 — surface     ← BLOCK_AI_SURFACE_PROMPT
 *   Layer 4 — quality     ← req.qualityDirectiveStr
 *   Layer 5 — document    ← req.documentText ('' for Block AI — selection is in user message)
 *   Layer 6 — instruction ← '' (Block AI puts instruction in the user message, not the system prompt)
 */

import { assemblePrompt, type AssemblyRequest } from '../main/prompts/assemble';

// ---------------------------------------------------------------------------
// Legacy v1.0 surface prompt
// ---------------------------------------------------------------------------

/**
 * The verbatim Block AI system prompt used in v1.0.
 *
 * In the legacy path (toggle OFF) this string is returned as-is (with the
 * quality directive appended), producing output byte-identical to v1.0.
 *
 * In the new path (toggle ON) this string is passed as the `surfacePrompt`
 * (layer 3) inside the AssemblyRequest, so the 7-layer ordering logic
 * places it correctly relative to systemlaw (0), owner (1), and quality (4).
 *
 * Exported so that `block-ai.ts` can import it as its `SYSTEM_PROMPT`
 * constant, eliminating duplication between the two files.
 */
export const BLOCK_AI_SURFACE_PROMPT =
  `You are a focused text-rewriting assistant inside a Markdown editor.
The user has selected a fragment of text and given an instruction.
Produce EXACTLY 3 alternative rewrites of the fragment. Rules:
- Output ONLY the 3 alternatives.
- Separate each alternative with a line containing exactly three dashes: ---
- Preserve the markdown semantic of the selection (heading stays heading, list stays list).
- Keep length in the same ballpark as the original unless the instruction asks otherwise.
- Match the user's language (Korean or English).
- No numbering, no commentary, no preamble.`;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Input to `buildBlockAiInstructions`.
 *
 * All string fields default to `''` when absent — the assembler drops
 * empty-content layers silently, so the result is always a coherent prompt.
 * Passing `toggleEnabled: false` (or omitting it) always returns the legacy
 * v1.0 path regardless of the other fields.
 */
export type BlockAiPromptRequest = {
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
   * Optional document context (layer 5).
   * Block AI surfaces its selection fragment in the *user message*, not here,
   * so in practice this is always `''` for Block AI in Phase 1.
   * Accepted for forward-compatibility with callers that pass document context.
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
// Core routing function
// ---------------------------------------------------------------------------

/**
 * Build the Block AI system-prompt instructions string, routing between the
 * v1.1 assembly path and the v1.0 legacy path based on `req.toggleEnabled`.
 *
 * Routing table:
 * | toggleEnabled | Path                 | Assembler called? |
 * |---------------|----------------------|-------------------|
 * | true          | 7-layer new path     | YES               |
 * | false         | Legacy v1.0 concat   | NO                |
 *
 * @param req       - Prompt assembly request from the Block AI surface.
 *                    `toggleEnabled` controls the routing; other fields feed
 *                    the assembler (new path) or are ignored (legacy path).
 * @param assemble  - Assembler function. Default: real `assemblePrompt`.
 *                    Inject a `vi.fn()` in tests to verify routing behaviour.
 * @returns         The assembled system-prompt string ready to pass as the
 *                  `instructions` argument to `window.api.aiChat`.
 *
 * Never throws.  When toggle is off and `qualityDirectiveStr` is empty,
 * returns only `BLOCK_AI_SURFACE_PROMPT`.  When toggle is on and all
 * content fields are empty, the assembler result may be `''` — acceptable.
 */
export function buildBlockAiInstructions(
  req: BlockAiPromptRequest,
  assemble: AssemblerFn = assemblePrompt,
): string {
  const qualityStr = req.qualityDirectiveStr ?? '';

  if (req.toggleEnabled) {
    // ── New 7-layer path ────────────────────────────────────────────────────
    // Delegate to the assembler with all content slices.
    // Empty strings are silently dropped by `assemblePrompt`'s filter step,
    // so callers need not guard against missing files here.
    const assemblyReq: AssemblyRequest = {
      surface:          'BlockAI',
      systemlawContent: req.systemlawContent ?? '',
      ownerContent:     req.ownerContent     ?? '',
      surfacePrompt:    BLOCK_AI_SURFACE_PROMPT,
      qualityDirective: qualityStr,
      documentText:     req.documentText     ?? '',
      // userInstruction is intentionally omitted — Block AI puts the
      // instruction in the user message, not the system prompt.
    };
    return assemble(assemblyReq);
  }

  // ── Legacy v1.0 path ───────────────────────────────────────────────────────
  // Reproduce the exact v1.0 concatenation:
  //   `${SYSTEM_PROMPT}\n\n${qualityDirective(getQuality())}`
  // If qualityStr is blank, return only the surface prompt (no trailing \n\n).
  const parts = [BLOCK_AI_SURFACE_PROMPT, qualityStr].filter((s) => s.trim().length > 0);
  return parts.join('\n\n');
}
