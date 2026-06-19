/**
 * assemble.ts — Top-level prompt assembly for the 7-layer prompt stack.
 *
 * Phase 1 of notepad-ai v1.1 "Prompt Stack Foundation".
 *
 * `assemblePrompt` is the single entry point that all four AI surfaces use
 * to compose a final system-prompt string.  It:
 *   1. Builds PromptLayer objects for all 7 slots from the caller-supplied
 *      AssemblyRequest (global layers, surface-specific layers, and context
 *      layers).
 *   2. Delegates ordering to `orderLayers` (canonical 7-layer schema).
 *   3. Filters out layers whose content is empty or whitespace-only
 *      (missing files / absent context are silently dropped — never crash).
 *   4. Joins non-empty layer contents with a double-newline separator.
 *
 * ─── Design invariant ────────────────────────────────────────────────────────
 *
 * This module NEVER reads the filesystem and NEVER calls IPC.  Callers are
 * responsible for loading userData files (systemlaw.md, Owner.md) and
 * populating the `systemlawContent` / `ownerContent` fields.  This function
 * only assembles what it is given; missing content is simply empty string.
 *
 * ─── Graceful fallback ───────────────────────────────────────────────────────
 *
 * Every content field defaults to `''` when absent or `undefined`.  If all
 * content is blank the function returns `''` — callers may treat that as
 * "no system prompt" if desired.  Nothing in this module ever throws.
 *
 * ─── Layer → field mapping ───────────────────────────────────────────────────
 *
 *   Layer 0 — systemlaw   ←  req.systemlawContent
 *   Layer 1 — owner       ←  req.ownerContent
 *   Layer 2 — overview    ←  always '' in Phase 1 (stub for Phase 2 cascade)
 *   Layer 3 — surface     ←  req.surfacePrompt
 *   Layer 4 — quality     ←  req.qualityDirective
 *   Layer 5 — document    ←  req.documentText
 *   Layer 6 — instruction ←  req.userInstruction
 */

import { orderLayers, type PromptLayer } from './order';
import type { AISurface } from './resolve';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * All the content slices needed to assemble one AI surface's system prompt.
 *
 * Every string field is optional at the type level (the `?` suffix or the
 * caller omitting it); absent fields default to `''` inside `assemblePrompt`.
 * This means callers can construct a partial request and the function will
 * still produce a coherent (possibly short) prompt rather than crashing.
 *
 * Layer mapping — see module header.
 */
export type AssemblyRequest = {
  /** Which AI surface is assembling the prompt. */
  surface: AISurface;

  /**
   * Pre-loaded content of `userData/systemlaw.md`.
   * Pass `''` (or omit) when the file does not exist or the feature toggle
   * is off — the layer will be silently dropped from the output.
   */
  systemlawContent?: string;

  /**
   * Pre-loaded content of `userData/Owner.md`.
   * Pass `''` (or omit) when the file does not exist — silently dropped.
   */
  ownerContent?: string;

  /**
   * Surface-specific system prompt (layer 3).
   * E.g. the Block AI rewrite instruction or the Side Chat consultant framing.
   */
  surfacePrompt?: string;

  /**
   * Quality-dial directive (layer 4).
   * E.g. "Write at an elementary school reading level."
   * Omit or pass `''` to exclude.
   */
  qualityDirective?: string;

  /**
   * Document text / selected context (layer 5).
   * E.g. the current editor content or the user's block selection.
   * Omit or pass `''` to exclude.
   */
  documentText?: string;

  /**
   * The user's specific instruction (layer 6).
   * E.g. "Rewrite this as a bullet list." or the chat message text.
   */
  userInstruction?: string;
};

/**
 * The final assembled context string produced by `assemblePrompt`.
 *
 * Non-empty layers are joined by a blank line (`\n\n`).  If all supplied
 * content is blank the result is `''` — callers may treat that as
 * "no system prompt".
 */
export type AssembledPrompt = string;

// ---------------------------------------------------------------------------
// Core function
// ---------------------------------------------------------------------------

/**
 * Compose the final ordered system-prompt string from an `AssemblyRequest`.
 *
 * Algorithm:
 *   1. Build a `PromptLayer` for each of the 7 canonical slots.
 *   2. Pass the array through `orderLayers` (idempotent here but ensures
 *      correctness and makes the dependency chain explicit).
 *   3. Drop layers whose trimmed content is empty.
 *   4. Join remaining layer contents with `\n\n`.
 *
 * Never throws: every field missing / all-blank → returns `''`.
 *
 * @param req - Fully or partially populated assembly request.
 * @returns   The assembled system-prompt string ready for the Codex API.
 */
export function assemblePrompt(req: AssemblyRequest): AssembledPrompt {
  // Build the full 7-layer array from the request fields.
  // Each field defaults to '' when absent so that empty layers are cleanly
  // dropped in the filter step below rather than crashing here.
  const layers: PromptLayer[] = [
    // Layer 0 — global AI conduct rules
    { kind: 'systemlaw',   content: req.systemlawContent   ?? '' },
    // Layer 1 — user persona / author context
    { kind: 'owner',       content: req.ownerContent       ?? '' },
    // Layer 2 — overview (Phase 1 stub — Phase 2 will populate via cascade)
    { kind: 'overview',    content: '' },
    // Layer 3 — surface-specific system prompt
    { kind: 'surface',     content: req.surfacePrompt      ?? '' },
    // Layer 4 — quality-dial directive
    { kind: 'quality',     content: req.qualityDirective   ?? '' },
    // Layer 5 — document / selection context
    { kind: 'document',    content: req.documentText       ?? '' },
    // Layer 6 — user's specific instruction
    { kind: 'instruction', content: req.userInstruction    ?? '' },
  ];

  // Enforce canonical 7-layer ordering (robust against future extension).
  const ordered = orderLayers(layers);

  // Drop layers whose content is empty or whitespace-only.
  // This silently handles missing files (systemlaw/owner), absent quality
  // directives, and surfaces that don't use every slot.
  const nonEmpty = ordered.filter((l) => l.content.trim().length > 0);

  // Concatenate with blank-line separator — the conventional prompt section
  // boundary that many language models respond well to.
  return nonEmpty.map((l) => l.content).join('\n\n');
}
