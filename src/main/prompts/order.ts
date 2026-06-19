/**
 * order.ts — 7-layer prompt-stack ordering primitive.
 *
 * Phase 1 of notepad-ai v1.1 "Prompt Stack Foundation".
 *
 * The 7-layer schema defines the canonical ordering for all context
 * slices that are assembled into a system prompt.  Every AI surface
 * (Block AI, Side Chat, Bottom Chat, Quality Dial) produces a flat
 * array of PromptLayer objects; `orderLayers` sorts that array into
 * the agreed position order before the slices are joined.
 *
 * Layer positions (0-indexed, lower = earlier in the assembled prompt):
 *
 *   0  systemlaw   Global AI conduct rules  (userData/systemlaw.md)
 *   1  owner       User persona             (userData/Owner.md)
 *   2  overview    Project / doc overview   (Overview.md cascade — stub for Phase 2)
 *   3  surface     Surface-specific system prompt
 *   4  quality     Quality-dial directive
 *   5  document    Document text / context
 *   6  instruction User's specific instruction
 *
 * Layers with an unrecognised `kind` are placed AFTER all known layers
 * (position Infinity) so they never crash the assembly — they simply
 * appear at the end.
 *
 * Sorting is STABLE: layers that share the same position keep their
 * original relative order.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** The canonical layer kinds in their natural 7-layer order. */
export const LAYER_KINDS = [
  'systemlaw',
  'owner',
  'overview',
  'surface',
  'quality',
  'document',
  'instruction',
] as const;

export type LayerKind = (typeof LAYER_KINDS)[number];

/**
 * A single context slice to be assembled into the final system prompt.
 *
 * `kind`    — Identifies which of the 7 slots this slice occupies.
 * `content` — The text that will be emitted into the assembled prompt.
 *             May be empty string; callers should filter blank slices
 *             before calling `orderLayers` when appropriate, but this
 *             module never rejects them.
 *
 * The type is intentionally open (`& Record<string, unknown>`) so
 * future phases can attach metadata (e.g. `sourcePath`, `hash`) without
 * breaking the ordering contract.
 */
export type PromptLayer = {
  kind: string;          // `LayerKind` at runtime; `string` for unknown-kind tolerance
  content: string;
} & Record<string, unknown>;

// ---------------------------------------------------------------------------
// Position map
// ---------------------------------------------------------------------------

/** Numeric position for each known layer kind. */
const LAYER_POSITION: Readonly<Record<LayerKind, number>> = {
  systemlaw:   0,
  owner:       1,
  overview:    2,
  surface:     3,
  quality:     4,
  document:    5,
  instruction: 6,
};

/**
 * Returns the sort key for a layer.
 * Unknown kinds map to `Infinity` so they land after all known layers.
 */
export function layerPosition(kind: string): number {
  if (kind in LAYER_POSITION) {
    return LAYER_POSITION[kind as LayerKind];
  }
  return Infinity;
}

// ---------------------------------------------------------------------------
// Core function
// ---------------------------------------------------------------------------

/**
 * Sort an array of prompt layers into the canonical 7-layer order.
 *
 * - Pure function: the input array is never mutated.
 * - Stable: layers at the same position preserve their original order.
 * - Graceful: unknown `kind` values are placed at the end without throwing.
 *
 * @param layers  Unordered array of prompt-layer objects.
 * @returns       New array sorted by layer position.
 */
export function orderLayers(layers: PromptLayer[]): PromptLayer[] {
  // Attach the original index so we can implement a stable sort even in
  // environments where Array#sort is not guaranteed stable.
  const indexed = layers.map((layer, idx) => ({ layer, idx }));

  indexed.sort((a, b) => {
    const posA = layerPosition(a.layer.kind);
    const posB = layerPosition(b.layer.kind);
    if (posA !== posB) return posA - posB;
    // Equal positions: preserve original order (stable).
    return a.idx - b.idx;
  });

  return indexed.map(({ layer }) => layer);
}
