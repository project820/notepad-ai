/**
 * side-chat-prompt-handler.ts
 *
 * Prompt-routing logic for the Side Chat (F4) surface.
 *
 * Sub-AC 3.3 of notepad-ai v1.1 Phase 1 — Prompt Stack Foundation.
 *
 * `readSideChatToggle` is the isolated toggle-read gate for this surface.
 * It reads the v1.1 prompt-assembly feature toggle via `isPromptAssemblyEnabled()`
 * and returns a boolean — with no routing, DOM access, IPC, or state mutations.
 *
 * `buildSideChatInstructions` is the single routing point for Side Chat's
 * system-prompt assembly.  It reads `req.toggleEnabled` and dispatches to:
 *
 *   • NEW PATH  (toggleEnabled = true)  — calls the injected `assemble`
 *     function with a fully-typed AssemblyRequest, including systemlaw and
 *     Owner content pre-loaded by the caller.
 *
 *   • LEGACY PATH (toggleEnabled = false) — returns the hard-coded v1.0
 *     `SIDE_CHAT_SURFACE_PROMPT` with the quality directive appended,
 *     producing a byte-identical result to v1.0.
 *
 * ─── Toggle-read isolation ────────────────────────────────────────────────────
 *
 * `readSideChatToggle()` is intentionally a named export at the top level so
 * it can be imported and spy-tested in isolation from the routing logic.
 * It consults exactly one toggle key — `isPromptAssemblyEnabled()` — and
 * returns its boolean value immediately, with no observable side-effects.
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
 * This module is a pure function with no DOM access, no IPC, no module-level
 * state.  Safe to import in any test environment.
 *
 * ─── Layer mapping for the new path ──────────────────────────────────────────
 *
 *   Layer 0 — systemlaw   ← req.systemlawContent
 *   Layer 1 — owner       ← req.ownerContent
 *   Layer 2 — overview    ← '' (stub — Phase 2)
 *   Layer 3 — surface     ← SIDE_CHAT_SURFACE_PROMPT
 *   Layer 4 — quality     ← req.qualityDirectiveStr
 *   Layer 5 — document    ← req.documentText (current document context)
 *   Layer 6 — instruction ← '' (Side Chat puts the user question in the user
 *                            message turn, not the system prompt)
 */

import { isPromptAssemblyEnabled } from '../main/prompts/toggle';
import { assemblePrompt, type AssemblyRequest } from '../main/prompts/assemble';

// ---------------------------------------------------------------------------
// Legacy v1.0 surface prompt
// ---------------------------------------------------------------------------

/**
 * The verbatim Side Chat system prompt used in v1.0.
 *
 * In the legacy path (toggle OFF) this string is returned as-is (with the
 * quality directive appended), producing output byte-identical to v1.0.
 *
 * In the new path (toggle ON) this string is passed as the `surfacePrompt`
 * (layer 3) inside the AssemblyRequest, so the 7-layer ordering logic
 * places it correctly relative to systemlaw (0), owner (1), and quality (4).
 *
 * Exported so tests can assert the legacy path uses exactly this string,
 * and so `side-chat.ts` can import it as its `systemPrompt` return value,
 * eliminating duplication between the two files.
 */
export const SIDE_CHAT_SURFACE_PROMPT =
  `You are an editorial consultant embedded in a Markdown editor.\n` +
  `The user is writing a document and is asking for your thoughts, not for rewritten content.\n` +
  `\n` +
  `Style:\n` +
  `- Be conversational and concise. Ask clarifying questions when useful.\n` +
  `- Offer perspective: structural feedback, missing pieces, tone, audience fit.\n` +
  `- Avoid producing full drafts unless explicitly asked; suggest *moves* instead.\n` +
  `- Match the user's language (Korean or English).\n` +
  `- Render answers in clean Markdown (headings/bullets allowed, no code fences around the whole reply).`;

// ---------------------------------------------------------------------------
// Toggle-read gate (Sub-AC 3.3a — isolated function)
// ---------------------------------------------------------------------------

/**
 * Reads the current state of the v1.1 prompt-assembly feature toggle
 * for the Side Chat surface.
 *
 * This is the isolated toggle-read function for Sub-AC 3.3a.  It consults
 * exactly one toggle key — `isPromptAssemblyEnabled()` from the central
 * toggle module — and returns its boolean value.
 *
 * ─── Isolation contract ───────────────────────────────────────────────────────
 *
 * This function:
 *   ✓ Always returns a boolean (never null, undefined, or a truthy/falsy non-bool)
 *   ✓ Consults exactly one toggle key: `isPromptAssemblyEnabled()`
 *   ✓ Has no DOM access
 *   ✓ Has no IPC calls
 *   ✓ Has no module-level state mutations
 *   ✓ Has no network calls
 *   ✓ Produces no observable side-effects beyond returning its value
 *
 * Calling this function 100 times with the same toggle state will always
 * return the same boolean — it is a pure read.
 *
 * ─── Usage ───────────────────────────────────────────────────────────────────
 *
 * ```ts
 * // At the Side Chat send() call-site:
 * const toggleOn = readSideChatToggle();
 * if (toggleOn) {
 *   // v1.1 path: build instructions via buildSideChatInstructions
 * } else {
 *   // v1.0 path: use inline systemPrompt() string
 * }
 * ```
 *
 * @returns `true` when the v1.1 prompt-assembly pipeline is currently enabled;
 *          `false` when the v1.0 legacy paths should be used (default).
 *
 * Never throws.
 */
export function readSideChatToggle(): boolean {
  return isPromptAssemblyEnabled();
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Input to `buildSideChatInstructions`.
 *
 * All string fields default to `''` when absent — the assembler drops
 * empty-content layers silently, so the result is always a coherent prompt.
 * Passing `toggleEnabled: false` (or omitting it) always returns the legacy
 * v1.0 path regardless of the other fields.
 */
export type SideChatPromptRequest = {
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
   * The current document text for context (layer 5).
   * Typically truncated by the caller before passing here (e.g. first 12 000
   * chars).  Pass `''` when the document is empty.
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
 * Build the Side Chat system-prompt instructions string, routing between the
 * v1.1 assembly path and the v1.0 legacy path based on `req.toggleEnabled`.
 *
 * Routing table:
 * | toggleEnabled | Path                 | Assembler called? |
 * |---------------|----------------------|-------------------|
 * | true          | 7-layer new path     | YES               |
 * | false         | Legacy v1.0 concat   | NO                |
 *
 * @param req       - Prompt assembly request from the Side Chat surface.
 *                    `toggleEnabled` controls the routing; other fields feed
 *                    the assembler (new path) or are ignored (legacy path).
 * @param assemble  - Assembler function. Default: real `assemblePrompt`.
 *                    Inject a `vi.fn()` in tests to verify routing behaviour.
 * @returns         The assembled system-prompt string ready to pass as the
 *                  `instructions` argument to `window.api.aiChat`.
 *
 * Never throws.  When toggle is off and `qualityDirectiveStr` is empty,
 * returns only `SIDE_CHAT_SURFACE_PROMPT`.  When toggle is on and all
 * content fields are empty, the assembler result may be `''` — acceptable.
 */
export function buildSideChatInstructions(
  req: SideChatPromptRequest,
  assemble: AssemblerFn = assemblePrompt,
): string {
  const qualityStr = req.qualityDirectiveStr ?? '';

  if (req.toggleEnabled) {
    // ── New 7-layer path ────────────────────────────────────────────────────
    // Delegate to the assembler with all content slices.
    // Empty strings are silently dropped by `assemblePrompt`'s filter step,
    // so callers need not guard against missing files here.
    const assemblyReq: AssemblyRequest = {
      surface:          'SideChat',
      systemlawContent: req.systemlawContent ?? '',
      ownerContent:     req.ownerContent     ?? '',
      surfacePrompt:    SIDE_CHAT_SURFACE_PROMPT,
      qualityDirective: qualityStr,
      documentText:     req.documentText     ?? '',
      // userInstruction is intentionally omitted — Side Chat puts the
      // user's question in the user message turn, not the system prompt.
    };
    return assemble(assemblyReq);
  }

  // ── Legacy v1.0 path ───────────────────────────────────────────────────────
  // Reproduce the exact v1.0 concatenation from side-chat.ts `send()`:
  //   `${systemPrompt()}\n\n${qd}\n\n=== Current document ===\n${doc}\n=== End document ===`
  //
  // For Phase 1 toggle-off we match the system-prompt + quality portion only
  // (the document context is assembled at call-time in side-chat.ts from
  // getDocument() — that part stays in the surface code until Phase 2).
  // If qualityStr is blank, return only the surface prompt (no trailing \n\n).
  const parts = [SIDE_CHAT_SURFACE_PROMPT, qualityStr].filter((s) => s.trim().length > 0);
  return parts.join('\n\n');
}
