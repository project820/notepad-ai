/**
 * quality-dial-adapter.ts — Quality Dial surface adapter for the 7-layer prompt stack.
 *
 * Phase 1 of notepad-ai v1.1 "Prompt Stack Foundation".
 *
 * `buildQualityDialInstructions` is the single call-site replacement for the
 * ad-hoc `qualityDirective(q)` string used inline by other AI surfaces (Block
 * AI, Side Chat, Bottom Chat) when they need to incorporate the reading-level
 * directive.
 *
 * ─── Toggle routing ──────────────────────────────────────────────────────────
 *
 * When `req.toggleEnabled` is `false` (the default):
 *   → Returns the v1.0 legacy string: `qualityDirective(req.quality)` verbatim.
 *     This is byte-identical to what each surface produced today — a single-line
 *     reading-level instruction like "Write at a professional level."
 *     No new code paths are entered; callers that have not opted in see zero
 *     behaviour change.
 *
 * When `req.toggleEnabled` is `true`:
 *   → Calls the injected `assemble` function (defaults to `assemblePrompt`)
 *     with a full `AssemblyRequest` that places the quality directive at
 *     Layer 4 and includes any available systemlaw / owner content at Layers
 *     0–1.
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
 *   - `assemble` returns ''                        → '' propagated.
 *   - Any valid `Quality` value is accepted; none cause a throw.
 *
 * ─── Rollback safety ─────────────────────────────────────────────────────────
 *
 * When `toggleEnabled` is `false`, this module returns the same string that
 * each surface produced in v1.0 via `qualityDirective(q)` — no new code paths
 * are entered.  The feature toggle defaults to off, guaranteeing that every
 * user who has not opted in sees zero behaviour change.
 *
 * ─── Layer mapping for the new path ──────────────────────────────────────────
 *
 *   Layer 0 — systemlaw   ← req.systemlawContent
 *   Layer 1 — owner       ← req.ownerContent
 *   Layer 2 — overview    ← '' (stub — Phase 2)
 *   Layer 3 — surface     ← '' (Quality Dial has no dedicated surface prompt;
 *                               the reading-level directive is itself the output)
 *   Layer 4 — quality     ← qualityDirective(req.quality)
 *   Layer 5 — document    ← '' (Quality Dial does not inject document context)
 *   Layer 6 — instruction ← '' (Quality Dial does not inject user instruction)
 */

import { assemblePrompt, type AssemblyRequest } from '../main/prompts/assemble';
import { qualityDirective, type Quality } from './quality';

// ---------------------------------------------------------------------------
// Public parameter type
// ---------------------------------------------------------------------------

/**
 * All inputs needed to build the Quality Dial prompt directive.
 *
 * Every field except `toggleEnabled` and `quality` is optional — missing /
 * empty values are silently dropped from the assembled output rather than
 * causing errors.
 *
 * Passing `toggleEnabled: false` (or omitting it, defaulting callers to false)
 * always returns the legacy v1.0 quality directive string regardless of the
 * other fields.
 */
export type QualityDialPromptRequest = {
  /**
   * Current state of the v1.1 feature toggle.
   * `true`  → use the 7-layer assembler.
   * `false` → use the legacy v1.0 path (default, off).
   */
  toggleEnabled: boolean;

  /**
   * The current quality-dial setting.
   * Used by `qualityDirective(q)` to produce the directive string.
   * Required — the directive cannot be built without a quality level.
   */
  quality: Quality;

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
 * Build the complete quality-directive string for the Quality Dial (F6).
 *
 * Routing:
 *   - Toggle OFF (default) → legacy v1.0 path: returns `qualityDirective(req.quality)`
 *     verbatim — a single reading-level instruction string.  Byte-identical to
 *     what each surface produced in v1.0 when injecting quality.
 *   - Toggle ON            → v1.1 path: `assemble` called with a 7-layer
 *     `AssemblyRequest` placing the quality directive at Layer 4, and any
 *     available systemlaw / owner content at Layers 0–1.
 *
 * @param req       - Quality Dial prompt inputs (`toggleEnabled` controls routing;
 *                   `quality` is always used; other fields feed the assembler
 *                   when toggle is on).
 * @param assemble  - Prompt assembler to use when toggle is ON.  Defaults to
 *                   the real `assemblePrompt`; pass a mock in tests.
 * @returns          The quality directive string (toggle-OFF), or the fully
 *                   assembled 7-layer prompt string (toggle-ON).  May return
 *                   `''` when the assembler returns `''`; callers may treat
 *                   that as "no quality directive to inject".
 *
 * Never throws.  All inputs are null-safe; missing files / empty content are
 * silently excluded from the assembled result.
 *
 * @example
 * // Production (no second arg — uses real assemblePrompt)
 * const directive = buildQualityDialInstructions({
 *   toggleEnabled:    isPromptAssemblyEnabled(),
 *   quality:          deps.getQuality(),
 *   systemlawContent: await readSystemlaw(userDataPath),
 *   ownerContent:     await readOwner(userDataPath),
 * });
 *
 * @example
 * // Test (inject mock assembler)
 * const directive = buildQualityDialInstructions(req, mockAssembler);
 */
export function buildQualityDialInstructions(
  req: QualityDialPromptRequest,
  assemble: AssemblerFn = assemblePrompt,
): string {
  // Compute the quality directive from the current quality setting.
  // `qualityDirective` never throws for any valid Quality value.
  const directive = qualityDirective(req.quality);

  if (req.toggleEnabled) {
    // ── New 7-layer path ────────────────────────────────────────────────────
    // Delegate to the assembler with all content slices.
    // Empty strings are silently dropped by `assemblePrompt`'s filter step.
    //
    // Quality Dial has no dedicated surface prompt (Layer 3 = '').
    // The quality directive is the primary contribution at Layer 4.
    const assemblyReq: AssemblyRequest = {
      surface:          'QualityDial',
      systemlawContent: req.systemlawContent ?? '',
      ownerContent:     req.ownerContent     ?? '',
      // surfacePrompt intentionally omitted — Quality Dial has no standalone
      // system prompt; the reading-level directive IS the output.
      qualityDirective: directive,
      // documentText and userInstruction intentionally omitted — Quality Dial
      // does not inject document context or user instructions.
    };
    return assemble(assemblyReq);
  }

  // ── Legacy v1.0 path ───────────────────────────────────────────────────────
  // Return the quality directive string verbatim.
  // This is exactly what each surface did in v1.0: call `qualityDirective(q)`
  // and append the result to the surface's own system prompt.
  return directive;
}
