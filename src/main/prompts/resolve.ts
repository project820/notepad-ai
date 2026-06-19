/**
 * resolve.ts — Surface-to-layer resolver for the 7-layer prompt stack.
 *
 * Phase 1 of notepad-ai v1.1 "Prompt Stack Foundation".
 *
 * `resolveLayersForSurface` returns the set of *global* prompt-layer descriptors
 * that apply to a given AI surface.  "Global" means the layers whose content is
 * stored in userData (app-wide), as opposed to surface-specific layers (layer 3),
 * quality directives (layer 4), document context (layer 5), and user instructions
 * (layer 6), which each surface assembles independently.
 *
 * ─── Phase 1 global layers ───────────────────────────────────────────────────
 *
 *   Position 0 — systemlaw  (userData/systemlaw.md)
 *     Global AI conduct rules.  Optional — missing file → content stays ''.
 *
 *   Position 1 — owner      (userData/Owner.md)
 *     User persona / author context.  Optional — missing file → content stays ''.
 *
 *   Position 2 — overview   (stub — Phase 2 cascade will populate this)
 *     Project/document overview.  Content is ALWAYS '' in Phase 1.
 *     Marked `isStub: true` so Phase 2 can detect which slot to fill.
 *
 * ─── Forward-compatibility ───────────────────────────────────────────────────
 *
 * The function accepts a surface identifier so that future phases can return
 * different layer sets per surface (e.g., @mention layers only for certain
 * surfaces, or overview excluded from QualityDial).  In Phase 1 all four
 * surfaces return the same three global layers.
 *
 * ─── Graceful fallback ───────────────────────────────────────────────────────
 *
 * Layers returned here have empty `content`.  The caller is responsible for
 * loading file content (via IPC) and populating each layer before calling
 * `orderLayers()` and joining the prompt.  If a file is missing the caller
 * should simply leave `content` as '' — the layer object is still valid.
 *
 * Callers MUST check the `featureEnabled` flag (v1.1 feature toggle) before
 * invoking this function; when the toggle is off the v1.0 code path is used
 * unchanged and this module is never called.
 *
 * ─── Phase 1 stub: resolveOverviewCascade ────────────────────────────────────
 *
 * `resolveOverviewCascade` is a typed stub exported for Phase 2 to replace.
 * It accepts the parameters that Phase 2 will use (documentPath) but performs
 * NO cascade logic.  It always returns `OVERVIEW_CASCADE_STUB` — an empty
 * overview layer — so the assembly pipeline can plug it in safely today.
 *
 * Phase 2 will:
 *   1. Walk ancestor directories of `documentPath` for `Overview.md` files.
 *   2. Merge their content (nearest-first) into the overview layer.
 *   3. Return a populated `SurfaceLayer` with the merged content.
 *
 * This module NEVER reads the filesystem.  That invariant holds even after
 * Phase 2 — the actual I/O will live in the IPC handler layer.
 */

import type { PromptLayer } from './order';

// ---------------------------------------------------------------------------
// Public surface identifier type
// ---------------------------------------------------------------------------

/**
 * The four AI surfaces available in notepad-ai v1.0 / v1.1.
 *
 * - **BlockAI**    F3 — text-selection-driven rewrite (3 alternatives).
 * - **SideChat**   F4 — consultant panel (read-only, no apply).
 * - **BottomChat** F5 — draft / rewrite with Apply / Replace buttons.
 * - **QualityDial** F6 — reading-level directive injected into all surfaces.
 */
export type AISurface = 'BlockAI' | 'SideChat' | 'BottomChat' | 'QualityDial';

/** The full set of valid surface identifiers for validation. */
export const VALID_SURFACES: ReadonlySet<AISurface> = new Set([
  'BlockAI',
  'SideChat',
  'BottomChat',
  'QualityDial',
]);

// ---------------------------------------------------------------------------
// Extended layer descriptor (PromptLayer + Phase 1 metadata)
// ---------------------------------------------------------------------------

/**
 * A prompt-layer descriptor returned by `resolveLayersForSurface`.
 *
 * Extends `PromptLayer` (kind + content) with Phase 1 metadata fields:
 *
 * - `optional`    — When `true`, missing file content is acceptable; the layer
 *                   is included in the stack with `content: ''` instead of
 *                   causing a crash or skipping the slot.
 * - `sourcePath`  — Filename relative to `app.getPath('userData')` that
 *                   provides the layer content.  Absent for stub layers.
 * - `isStub`      — When `true`, Phase 2+ will populate `content`; in Phase 1
 *                   the content is always `''` and callers must not attempt
 *                   to read or interpret it.
 */
export type SurfaceLayer = PromptLayer & {
  optional: boolean;
  sourcePath?: string;
  isStub?: boolean;
};

// ---------------------------------------------------------------------------
// Core resolver
// ---------------------------------------------------------------------------

/**
 * Return the ordered set of global prompt-layer descriptors for an AI surface.
 *
 * All four Phase 1 surfaces receive the same three global layers:
 *   1. systemlaw (position 0) — from userData/systemlaw.md
 *   2. owner     (position 1) — from userData/Owner.md
 *   3. overview  (position 2) — stub for Phase 2 cascade
 *
 * Layers are returned in canonical 7-layer order (positions 0, 1, 2).
 * Content is always `''`; callers populate it before assembling the prompt.
 *
 * @param surface - One of the four AI surface identifiers.
 * @returns       Array of SurfaceLayer objects in canonical order.
 * @throws        {RangeError} when `surface` is not one of the four valid values.
 */
export function resolveLayersForSurface(surface: AISurface): SurfaceLayer[] {
  if (!VALID_SURFACES.has(surface)) {
    throw new RangeError(
      `resolveLayersForSurface: unknown surface "${surface}". ` +
      `Valid values: ${[...VALID_SURFACES].join(', ')}.`,
    );
  }

  // All four surfaces share the same global layer set in Phase 1.
  // The surface parameter is accepted for forward-compatibility (Phase 2+
  // may return different sets per surface, e.g. @mention layers).
  return [
    // ── Layer 0: systemlaw ──────────────────────────────────────────────────
    // Global AI conduct rules.  Loaded from userData/systemlaw.md.
    // When the file does not exist, content stays '' — never crash.
    {
      kind: 'systemlaw',
      content: '',
      optional: true,
      sourcePath: 'systemlaw.md',
    },

    // ── Layer 1: owner ──────────────────────────────────────────────────────
    // User persona / author context.  Loaded from userData/Owner.md.
    // When the file does not exist, content stays '' — never crash.
    {
      kind: 'owner',
      content: '',
      optional: true,
      sourcePath: 'Owner.md',
    },

    // ── Layer 2: overview (stub) ─────────────────────────────────────────────
    // Project / document overview.  Phase 2 will implement the cascade that
    // walks ancestor directories for Overview.md files.  In Phase 1 this
    // slot is always empty (`isStub: true`).  Callers must NOT attempt to
    // read or populate this layer — Phase 2 owns that pipeline.
    {
      kind: 'overview',
      content: '',
      optional: true,
      isStub: true,
    },
  ];
}

// ---------------------------------------------------------------------------
// Phase 1 stub: resolveOverviewCascade
// ---------------------------------------------------------------------------

/**
 * Parameters accepted by `resolveOverviewCascade`.
 *
 * Phase 2 will use `documentPath` as the starting point for walking ancestor
 * directories to find `Overview.md` files.  In Phase 1 the function accepts
 * (and ignores) this value — it is typed here so call-sites are forward-
 * compatible with Phase 2 without requiring a signature change.
 */
export type OverviewCascadeParams = {
  /**
   * Absolute filesystem path to the currently open document.
   *
   * Phase 2 walks from this path toward the filesystem root, collecting any
   * `Overview.md` file found in each ancestor directory, then merges them
   * (nearest-first) into a single overview layer.
   *
   * Phase 1 ignores this field entirely; the stub returns an empty layer
   * regardless of the value provided.
   */
  documentPath: string;
};

/**
 * Sentinel value returned by the Phase 1 `resolveOverviewCascade` stub.
 *
 * Structure:
 *   - `kind: 'overview'`    — canonical position 2 in the 7-layer stack
 *   - `content: ''`         — no cascade performed; content is always empty
 *   - `optional: true`      — missing content never crashes the assembly
 *   - `isStub: true`        — Phase 2 can detect and replace this slot
 *
 * The object is frozen so call-sites cannot accidentally mutate the sentinel.
 * `resolveOverviewCascade` spreads a shallow copy on each call so callers
 * receive an independent, mutable layer object.
 */
export const OVERVIEW_CASCADE_STUB: Readonly<SurfaceLayer> = Object.freeze({
  kind: 'overview',
  content: '',
  optional: true,
  isStub: true,
} satisfies SurfaceLayer);

/**
 * **Phase 1 stub** — Overview.md cascade resolver.
 *
 * Returns the empty overview sentinel layer (`OVERVIEW_CASCADE_STUB`).
 * No filesystem access, no cascade logic, never throws.
 *
 * ─── What Phase 2 will implement ────────────────────────────────────────────
 *
 * Phase 2 will replace (or wrap) this stub with real cascade logic:
 *   1. Walk ancestor directories of `params.documentPath`.
 *   2. Collect each `Overview.md` found along the path (nearest-first).
 *   3. Merge collected content into a single overview string.
 *   4. Return a `SurfaceLayer` with `kind: 'overview'` and `isStub: false`.
 *
 * The function signature (`params: OverviewCascadeParams`) is intentionally
 * fixed here so Phase 2 can drop in a replacement without touching call-sites.
 *
 * ─── Phase 1 behaviour ───────────────────────────────────────────────────────
 *
 * - `params` is accepted but ignored entirely.
 * - Returns a shallow copy of `OVERVIEW_CASCADE_STUB` on every call.
 * - Each returned object is a new reference; mutating it does not affect
 *   subsequent calls or the frozen sentinel constant.
 * - Never throws for any value of `params.documentPath`.
 *
 * @param _params - Cascade parameters (typed for Phase 2; ignored in Phase 1).
 * @returns       A fresh copy of the empty overview sentinel layer.
 */
export function resolveOverviewCascade(_params: OverviewCascadeParams): SurfaceLayer {
  // Phase 1: spread a shallow copy so each call returns an independent object.
  // Phase 2 will replace this body with real cascade logic.
  return { ...OVERVIEW_CASCADE_STUB };
}

// ---------------------------------------------------------------------------
// Phase 1 stub: resolveMentions
// ---------------------------------------------------------------------------

/**
 * Parameters accepted by `resolveMentions`.
 *
 * Phase 2+ will use `text` to extract @mention tokens and resolve each one
 * to document content, file paths, or other context injections.  In Phase 1
 * the function accepts (and ignores) this value — it is typed here so
 * call-sites are forward-compatible with future phases without requiring a
 * signature change.
 */
export type MentionResolutionParams = {
  /**
   * The raw text that may contain @mention tokens (e.g. "@filename", "@section").
   *
   * Phase 2+ will parse this string to identify mention tokens, resolve each
   * one to its corresponding content, and inject the results into the prompt
   * assembly pipeline.
   *
   * Phase 1 ignores this field entirely; the stub returns an empty array
   * regardless of the value provided.
   */
  text: string;
};

/**
 * A single resolved @mention entry.
 *
 * Phase 2+ will populate instances of this type with real content.  In Phase 1
 * the type is defined here to establish the data model, but `resolveMentions`
 * always returns an empty array — no instances are ever constructed.
 *
 * Fields are intentionally minimal for Phase 1; Phase 2 will extend this type
 * as the resolution strategy becomes concrete.
 */
export type MentionResolution = {
  /** The raw @mention token as it appeared in the source text (e.g. "@Overview"). */
  token: string;
  /**
   * The content resolved from the mention.
   * Always empty string in Phase 1; real content in Phase 2+.
   */
  content: string;
};

/**
 * Sentinel value returned by the Phase 1 `resolveMentions` stub.
 *
 * Always a frozen empty array — no mentions are resolved in Phase 1.
 * The constant is frozen to prevent accidental mutation of the sentinel.
 * `resolveMentions` returns a new empty array on each call so callers
 * receive an independent, mutable result.
 */
export const MENTIONS_STUB: ReadonlyArray<MentionResolution> = Object.freeze([]);

/**
 * **Phase 1 stub** — @mention resolver.
 *
 * Returns a new empty array on every call.  No mention parsing, no filesystem
 * access, no cascade logic, never throws.
 *
 * ─── What Phase 2 will implement ────────────────────────────────────────────
 *
 * Phase 2 will replace (or wrap) this stub with real @mention resolution:
 *   1. Parse `params.text` for @mention tokens (e.g. `@Overview`, `@filename`).
 *   2. For each token, resolve it to a file path, document section, or other
 *      context slice.
 *   3. Return an array of `MentionResolution` objects with populated `content`.
 *
 * The function signature (`params: MentionResolutionParams`) is intentionally
 * fixed here so Phase 2 can drop in a replacement without touching call-sites.
 *
 * ─── Phase 1 behaviour ───────────────────────────────────────────────────────
 *
 * - `params` is accepted but ignored entirely.
 * - Returns a new `[]` on every call (never the frozen `MENTIONS_STUB` reference,
 *   so callers can push to the returned array without touching the sentinel).
 * - Never throws for any value of `params.text`.
 *
 * @param _params - Mention resolution parameters (typed for Phase 2; ignored in Phase 1).
 * @returns       A new empty array — no mentions resolved in Phase 1.
 */
export function resolveMentions(_params: MentionResolutionParams): MentionResolution[] {
  // Phase 1: return a fresh empty array on each call.
  // Phase 2 will replace this body with real @mention resolution logic.
  return [];
}
