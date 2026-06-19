/**
 * assemble-sparse-order.test.ts
 *
 * Sub-AC 8.3: The `assemblePrompt` function has a unit test with a sparse
 * synthetic input (only a subset of layers populated) and asserts the
 * relative ordering of the present layers still matches the spec ordering
 * with no positional gaps violating rank precedence.
 *
 * "Sparse" means only 2–5 of the 7 layer slots are populated; the remaining
 * slots are either absent from the AssemblyRequest or explicitly set to ''.
 * Despite the gaps, the present layers must appear in strict spec order:
 *
 *   Layer 1 (pos 0) — systemlaw     (req.systemlawContent)
 *   Layer 2 (pos 1) — owner         (req.ownerContent)
 *   Layer 3 (pos 2) — overview      (always '' in Phase 1 — never in output)
 *   Layer 4 (pos 3) — surface       (req.surfacePrompt)
 *   Layer 5 (pos 4) — quality       (req.qualityDirective)
 *   Layer 6 (pos 5) — document      (req.documentText)
 *   Layer 7 (pos 6) — instruction   (req.userInstruction)
 *
 * "No positional gaps violating rank precedence" means: for any two present
 * layers A (spec rank N) and B (spec rank M) where N < M, A must appear
 * before B in the assembled output, regardless of how many intermediate
 * layers between N and M are absent.
 *
 * Test groups:
 *   A. 2-layer sparse combinations — all distinct pairs
 *   B. 3-layer sparse combinations — representative triples
 *   C. 4-layer sparse combinations — representative quads
 *   D. 5-layer sparse combinations — one layer absent at a time
 *   E. Rank-precedence invariant — parametric ALL-PAIRS checks
 *   F. No empty gaps between present layers (separator is always \n\n, never \n\n\n)
 *   G. Explicit empty fields behave identically to absent fields
 *   H. Sparse inputs spanning non-adjacent spec positions (large rank gaps)
 *   I. Single-layer degenerate-sparse cases — output is exactly the layer content
 */

import { describe, it, expect } from 'vitest';
import { assemblePrompt, type AssemblyRequest } from '../../src/main/prompts/assemble';
import type { AISurface } from '../../src/main/prompts/resolve';

// ---------------------------------------------------------------------------
// Synthetic slot strings
//
// Each string is unique and deliberately verbose so that:
//   1. No two strings share a common substring prefix.
//   2. indexOf assertions are unambiguous.
//   3. The spec layer number is embedded in the string for readability.
// ---------------------------------------------------------------------------

/** Distinct synthetic content for each spec layer (1-indexed). */
const SPARSE = {
  /** Layer 1 — systemlaw (spec position 0) */
  sl:  'SPARSE_LAYER1_SYSTEMLAW_SL_UNIQUE_TOKEN',
  /** Layer 2 — owner (spec position 1) */
  ow:  'SPARSE_LAYER2_OWNER_OW_UNIQUE_TOKEN',
  // Layer 3 — overview is never user-controllable in Phase 1; omitted here.
  /** Layer 4 — surface (spec position 3) */
  sf:  'SPARSE_LAYER4_SURFACE_SF_UNIQUE_TOKEN',
  /** Layer 5 — quality (spec position 4) */
  q:   'SPARSE_LAYER5_QUALITY_Q_UNIQUE_TOKEN',
  /** Layer 6 — document (spec position 5) */
  doc: 'SPARSE_LAYER6_DOCUMENT_DOC_UNIQUE_TOKEN',
  /** Layer 7 — instruction (spec position 6) */
  ins: 'SPARSE_LAYER7_INSTRUCTION_INS_UNIQUE_TOKEN',
} as const;

/** Spec-rank order for the 6 user-controllable layers (ascending). */
const LAYER_RANK_ORDER = [SPARSE.sl, SPARSE.ow, SPARSE.sf, SPARSE.q, SPARSE.doc, SPARSE.ins] as const;

/** Surfaces to rotate through so we test surface-agnosticism. */
const SURFACES: AISurface[] = ['BlockAI', 'SideChat', 'BottomChat', 'QualityDial'];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Assert that `earlier` appears before `later` in `text`.
 * Both strings must be present; earlier index < later index.
 *
 * @param text     - The assembled prompt string to inspect.
 * @param earlier  - The string that must appear first.
 * @param later    - The string that must appear after `earlier`.
 */
function assertOrder(text: string, earlier: string, later: string): void {
  const idxA = text.indexOf(earlier);
  const idxB = text.indexOf(later);
  expect(idxA).toBeGreaterThanOrEqual(0);
  expect(idxB).toBeGreaterThanOrEqual(0);
  expect(idxA).toBeLessThan(idxB);
}

/**
 * Assert that ALL pairs (A, B) in `presentTokens` where A precedes B in
 * LAYER_RANK_ORDER appear in that order in `text`.
 *
 * This is the core rank-precedence invariant check: for every possible pair
 * of present layers, the lower-ranked one must come first.
 *
 * @param text           - The assembled prompt string.
 * @param presentTokens  - The subset of LAYER_RANK_ORDER tokens that were
 *                         supplied to `assemblePrompt`.
 */
function assertAllPairsInRankOrder(text: string, presentTokens: readonly string[]): void {
  // Filter LAYER_RANK_ORDER to only the tokens that were actually supplied.
  const orderedPresent = LAYER_RANK_ORDER.filter((t) => presentTokens.includes(t));

  // For every adjacent pair in the filtered (spec-ordered) list, assert order.
  for (let i = 0; i < orderedPresent.length - 1; i++) {
    for (let j = i + 1; j < orderedPresent.length; j++) {
      assertOrder(text, orderedPresent[i], orderedPresent[j]);
    }
  }
}

/**
 * Build a minimal AssemblyRequest from a subset of layer tokens.
 * Only the fields corresponding to the provided SPARSE tokens are set;
 * all other optional fields are left absent (undefined).
 *
 * @param surface  - The AI surface identifier.
 * @param tokens   - The SPARSE token values to include.
 */
function sparseRequest(surface: AISurface, tokens: readonly string[]): AssemblyRequest {
  const req: AssemblyRequest = { surface };
  if (tokens.includes(SPARSE.sl))  req.systemlawContent = SPARSE.sl;
  if (tokens.includes(SPARSE.ow))  req.ownerContent     = SPARSE.ow;
  if (tokens.includes(SPARSE.sf))  req.surfacePrompt    = SPARSE.sf;
  if (tokens.includes(SPARSE.q))   req.qualityDirective = SPARSE.q;
  if (tokens.includes(SPARSE.doc)) req.documentText     = SPARSE.doc;
  if (tokens.includes(SPARSE.ins)) req.userInstruction  = SPARSE.ins;
  return req;
}

// ===========================================================================
// A. 2-layer sparse combinations
//
// For each distinct pair drawn from the 6 user-controllable layers, verify:
//   1. Both tokens are present in the output.
//   2. The lower-ranked token precedes the higher-ranked token.
//   3. The output contains exactly one \n\n separator.
//   4. assemblePrompt does not throw.
// ===========================================================================

describe('A. 2-layer sparse combinations', () => {
  /** All 15 distinct pairs from 6 tokens (C(6,2)). */
  const PAIRS: [string, string][] = [
    [SPARSE.sl,  SPARSE.ow],   // Layer 1 → Layer 2
    [SPARSE.sl,  SPARSE.sf],   // Layer 1 → Layer 4 (skip 2,3)
    [SPARSE.sl,  SPARSE.q],    // Layer 1 → Layer 5 (skip 2,3,4)
    [SPARSE.sl,  SPARSE.doc],  // Layer 1 → Layer 6 (skip 2,3,4,5)
    [SPARSE.sl,  SPARSE.ins],  // Layer 1 → Layer 7 (skip 2,3,4,5,6)
    [SPARSE.ow,  SPARSE.sf],   // Layer 2 → Layer 4 (skip 3)
    [SPARSE.ow,  SPARSE.q],    // Layer 2 → Layer 5 (skip 3,4)
    [SPARSE.ow,  SPARSE.doc],  // Layer 2 → Layer 6 (skip 3,4,5)
    [SPARSE.ow,  SPARSE.ins],  // Layer 2 → Layer 7 (skip 3,4,5,6)
    [SPARSE.sf,  SPARSE.q],    // Layer 4 → Layer 5
    [SPARSE.sf,  SPARSE.doc],  // Layer 4 → Layer 6 (skip 5)
    [SPARSE.sf,  SPARSE.ins],  // Layer 4 → Layer 7 (skip 5,6)
    [SPARSE.q,   SPARSE.doc],  // Layer 5 → Layer 6
    [SPARSE.q,   SPARSE.ins],  // Layer 5 → Layer 7 (skip 6)
    [SPARSE.doc, SPARSE.ins],  // Layer 6 → Layer 7
  ];

  for (const [lower, higher] of PAIRS) {
    // Derive a human-readable label from the token for the test name.
    const labelOf = (t: string) => t.split('_').slice(-3, -1).join('_');
    const pairLabel = `${labelOf(lower)} → ${labelOf(higher)}`;

    it(`A — assemblePrompt does not throw for pair: ${pairLabel}`, () => {
      expect(() => assemblePrompt(sparseRequest('BlockAI', [lower, higher]))).not.toThrow();
    });

    it(`A — both tokens are present in output for pair: ${pairLabel}`, () => {
      const result = assemblePrompt(sparseRequest('BlockAI', [lower, higher]));
      expect(result).toContain(lower);
      expect(result).toContain(higher);
    });

    it(`A — lower-rank token precedes higher-rank token for pair: ${pairLabel}`, () => {
      const result = assemblePrompt(sparseRequest('BlockAI', [lower, higher]));
      assertOrder(result, lower, higher);
    });

    it(`A — exactly one separator \\n\\n for pair: ${pairLabel}`, () => {
      const result = assemblePrompt(sparseRequest('BlockAI', [lower, higher]));
      const seps = (result.match(/\n\n/g) ?? []).length;
      expect(seps).toBe(1);
    });
  }
});

// ===========================================================================
// B. 3-layer sparse combinations
//
// Representative triples that span non-adjacent spec positions.
// Verifies that the 3 present layers appear in strict spec order
// with exactly 2 separators and no rank-precedence violations.
// ===========================================================================

describe('B. 3-layer sparse combinations', () => {
  /** Triples: (tokens[], description) */
  const TRIPLES: Array<[string[], string]> = [
    // Layer 1, 4, 7 — spans the full range, skipping 2, 3, 5, 6
    [[SPARSE.sl, SPARSE.sf, SPARSE.ins], 'L1 → L4 → L7 (skip 2,3,5,6)'],
    // Layer 1, 2, 7 — beginning and end, skipping 3,4,5,6
    [[SPARSE.sl, SPARSE.ow, SPARSE.ins], 'L1 → L2 → L7 (skip 3,4,5,6)'],
    // Layer 2, 5, 7 — middle span
    [[SPARSE.ow, SPARSE.q, SPARSE.ins],  'L2 → L5 → L7 (skip 3,4,6)'],
    // Layer 1, 5, 6 — skip 2, 3, 4
    [[SPARSE.sl, SPARSE.q, SPARSE.doc],  'L1 → L5 → L6 (skip 2,3,4)'],
    // Layer 2, 4, 6 — alternating skip
    [[SPARSE.ow, SPARSE.sf, SPARSE.doc], 'L2 → L4 → L6 (skip 3,5)'],
    // Layer 1, 2, 6 — skip 3, 4, 5
    [[SPARSE.sl, SPARSE.ow, SPARSE.doc], 'L1 → L2 → L6 (skip 3,4,5)'],
    // Layer 4, 5, 7 — consecutive then gap
    [[SPARSE.sf, SPARSE.q, SPARSE.ins],  'L4 → L5 → L7 (skip 6)'],
    // Layer 1, 6, 7 — skip everything in between
    [[SPARSE.sl, SPARSE.doc, SPARSE.ins], 'L1 → L6 → L7 (skip 2,3,4,5)'],
  ];

  for (const [tokens, desc] of TRIPLES) {
    it(`B — no throw: ${desc}`, () => {
      expect(() => assemblePrompt(sparseRequest('SideChat', tokens))).not.toThrow();
    });

    it(`B — all 3 tokens present: ${desc}`, () => {
      const result = assemblePrompt(sparseRequest('SideChat', tokens));
      for (const t of tokens) {
        expect(result).toContain(t);
      }
    });

    it(`B — rank-precedence holds (all pairs): ${desc}`, () => {
      const result = assemblePrompt(sparseRequest('SideChat', tokens));
      assertAllPairsInRankOrder(result, tokens);
    });

    it(`B — exactly 2 separators (no gaps creating extra newlines): ${desc}`, () => {
      const result = assemblePrompt(sparseRequest('SideChat', tokens));
      const seps = (result.match(/\n\n/g) ?? []).length;
      expect(seps).toBe(2);
    });

    it(`B — no triple newline (absent layers leave no empty slots): ${desc}`, () => {
      const result = assemblePrompt(sparseRequest('SideChat', tokens));
      expect(result).not.toContain('\n\n\n');
    });
  }
});

// ===========================================================================
// C. 4-layer sparse combinations
//
// Representative quads that cover a variety of gap patterns.
// Verifies rank-precedence and separator count.
// ===========================================================================

describe('C. 4-layer sparse combinations', () => {
  const QUADS: Array<[string[], string]> = [
    // Layer 1, 2, 4, 7 — skip 3, 5, 6
    [[SPARSE.sl, SPARSE.ow, SPARSE.sf, SPARSE.ins],   'L1,L2,L4,L7 (skip 3,5,6)'],
    // Layer 1, 4, 5, 7 — skip 2, 3, 6
    [[SPARSE.sl, SPARSE.sf, SPARSE.q, SPARSE.ins],    'L1,L4,L5,L7 (skip 2,3,6)'],
    // Layer 1, 2, 5, 6 — skip 3, 4
    [[SPARSE.sl, SPARSE.ow, SPARSE.q, SPARSE.doc],    'L1,L2,L5,L6 (skip 3,4)'],
    // Layer 2, 4, 6, 7 — skip 1, 3, 5
    [[SPARSE.ow, SPARSE.sf, SPARSE.doc, SPARSE.ins],  'L2,L4,L6,L7 (skip 1,3,5)'],
    // Layer 1, 2, 4, 6 — skip 3, 5
    [[SPARSE.sl, SPARSE.ow, SPARSE.sf, SPARSE.doc],   'L1,L2,L4,L6 (skip 3,5)'],
    // Layer 1, 5, 6, 7 — skip 2, 3, 4
    [[SPARSE.sl, SPARSE.q, SPARSE.doc, SPARSE.ins],   'L1,L5,L6,L7 (skip 2,3,4)'],
    // Layer 2, 4, 5, 7 — skip 1, 3, 6
    [[SPARSE.ow, SPARSE.sf, SPARSE.q, SPARSE.ins],    'L2,L4,L5,L7 (skip 1,3,6)'],
    // Layer 1, 4, 6, 7 — skip 2, 3, 5
    [[SPARSE.sl, SPARSE.sf, SPARSE.doc, SPARSE.ins],  'L1,L4,L6,L7 (skip 2,3,5)'],
  ];

  for (const [tokens, desc] of QUADS) {
    it(`C — no throw: ${desc}`, () => {
      expect(() => assemblePrompt(sparseRequest('BottomChat', tokens))).not.toThrow();
    });

    it(`C — all 4 tokens present: ${desc}`, () => {
      const result = assemblePrompt(sparseRequest('BottomChat', tokens));
      for (const t of tokens) {
        expect(result).toContain(t);
      }
    });

    it(`C — rank-precedence holds for all pairs: ${desc}`, () => {
      const result = assemblePrompt(sparseRequest('BottomChat', tokens));
      assertAllPairsInRankOrder(result, tokens);
    });

    it(`C — exactly 3 separators (absent layers leave no empty slots): ${desc}`, () => {
      const result = assemblePrompt(sparseRequest('BottomChat', tokens));
      const seps = (result.match(/\n\n/g) ?? []).length;
      expect(seps).toBe(3);
    });
  }
});

// ===========================================================================
// D. 5-layer sparse combinations
//
// Each of the 6 user-controllable layers omitted once ("leave one out").
// Verifies that rank-precedence holds after each omission.
// ===========================================================================

describe('D. 5-layer sparse combinations (leave-one-out)', () => {
  const ALL_SIX = [SPARSE.sl, SPARSE.ow, SPARSE.sf, SPARSE.q, SPARSE.doc, SPARSE.ins];

  /**
   * Leave-one-out: for each index i, include all tokens EXCEPT ALL_SIX[i].
   * The omitted token's name is used as the description.
   */
  const LEAVE_ONE_OUT: Array<[string[], string]> = ALL_SIX.map((omit, i) => {
    const remaining = ALL_SIX.filter((_, j) => j !== i);
    const omitName  = omit.split('_').slice(1, 3).join('_'); // e.g. "LAYER1_SYSTEMLAW"
    return [remaining, `omit ${omitName}`];
  });

  for (const [tokens, desc] of LEAVE_ONE_OUT) {
    it(`D — no throw: ${desc}`, () => {
      expect(() => assemblePrompt(sparseRequest('QualityDial', tokens))).not.toThrow();
    });

    it(`D — exactly 5 tokens present: ${desc}`, () => {
      const result = assemblePrompt(sparseRequest('QualityDial', tokens));
      for (const t of tokens) {
        expect(result).toContain(t);
      }
      expect(result.split('\n\n')).toHaveLength(5);
    });

    it(`D — rank-precedence holds for all present pairs: ${desc}`, () => {
      const result = assemblePrompt(sparseRequest('QualityDial', tokens));
      assertAllPairsInRankOrder(result, tokens);
    });

    it(`D — exactly 4 separators (no gap from missing layer): ${desc}`, () => {
      const result = assemblePrompt(sparseRequest('QualityDial', tokens));
      const seps = (result.match(/\n\n/g) ?? []).length;
      expect(seps).toBe(4);
    });

    it(`D — no triple newline (absent layer creates no gap): ${desc}`, () => {
      const result = assemblePrompt(sparseRequest('QualityDial', tokens));
      expect(result).not.toContain('\n\n\n');
    });
  }
});

// ===========================================================================
// E. Rank-precedence invariant — parametric ALL-PAIRS checks
//
// For a curated list of sparse combinations, verify that EVERY pair of
// present layers obeys rank precedence — not just adjacent pairs.
// This is the direct embodiment of "no positional gaps violating rank
// precedence": even when layers 2, 3, 4, 5 are absent, layer 1 must
// still precede layer 6 in the output.
// ===========================================================================

describe('E. Rank-precedence invariant — parametric all-pairs', () => {
  /**
   * Each entry: [tokens, surface, description]
   * tokens lists the SPARSE values that are populated.
   */
  const CASES: Array<[string[], AISurface, string]> = [
    // --- Minimal extremes: first and last layer only ---
    [[SPARSE.sl, SPARSE.ins], 'BlockAI',    'L1 and L7 only — largest rank gap'],

    // --- First layer vs every other layer ---
    [[SPARSE.sl, SPARSE.sf],  'SideChat',   'L1 vs L4 (skip 2,3)'],
    [[SPARSE.sl, SPARSE.q],   'BottomChat', 'L1 vs L5 (skip 2,3,4)'],
    [[SPARSE.sl, SPARSE.doc], 'QualityDial','L1 vs L6 (skip 2,3,4,5)'],

    // --- Last layer vs every other layer ---
    [[SPARSE.ow,  SPARSE.ins], 'BlockAI',   'L2 vs L7 (skip 3,4,5,6)'],
    [[SPARSE.sf,  SPARSE.ins], 'SideChat',  'L4 vs L7 (skip 5,6)'],
    [[SPARSE.q,   SPARSE.ins], 'BottomChat','L5 vs L7 (skip 6)'],

    // --- Non-adjacent middle layers ---
    [[SPARSE.ow, SPARSE.q],   'QualityDial','L2 vs L5 (skip 3,4)'],
    [[SPARSE.ow, SPARSE.doc], 'BlockAI',    'L2 vs L6 (skip 3,4,5)'],
    [[SPARSE.sf, SPARSE.doc], 'SideChat',   'L4 vs L6 (skip 5)'],

    // --- Three-layer with a gap in the middle ---
    [[SPARSE.sl, SPARSE.q, SPARSE.ins],       'BlockAI',    'L1, L5, L7 (skip 2,3,4,6)'],
    [[SPARSE.ow, SPARSE.sf, SPARSE.ins],      'SideChat',   'L2, L4, L7 (skip 3,5,6)'],
    [[SPARSE.sl, SPARSE.ow, SPARSE.ins],      'BottomChat', 'L1, L2, L7 (skip 3,4,5,6)'],
    [[SPARSE.sl, SPARSE.doc, SPARSE.ins],     'QualityDial','L1, L6, L7 (skip 2,3,4,5)'],

    // --- Four-layer with spread-out gaps ---
    [[SPARSE.sl, SPARSE.sf, SPARSE.doc, SPARSE.ins],  'BlockAI',  'L1,L4,L6,L7'],
    [[SPARSE.ow, SPARSE.q,  SPARSE.doc, SPARSE.ins],  'SideChat', 'L2,L5,L6,L7'],
    [[SPARSE.sl, SPARSE.ow, SPARSE.q,   SPARSE.ins],  'BottomChat','L1,L2,L5,L7'],
    [[SPARSE.sl, SPARSE.ow, SPARSE.doc, SPARSE.ins],  'QualityDial','L1,L2,L6,L7 (skip 3,4,5)'],
  ];

  for (const [tokens, surface, desc] of CASES) {
    it(`E — all pairs in rank order: ${desc}`, () => {
      const result = assemblePrompt(sparseRequest(surface, tokens));

      // Assert every pair of present tokens (by spec rank order).
      assertAllPairsInRankOrder(result, tokens);

      // Also assert positions strictly increase.
      const orderedPresent = LAYER_RANK_ORDER.filter((t) => tokens.includes(t));
      const positions      = orderedPresent.map((t) => result.indexOf(t));
      expect(positions.every((p) => p >= 0)).toBe(true);
      for (let i = 1; i < positions.length; i++) {
        expect(positions[i]).toBeGreaterThan(positions[i - 1]);
      }
    });
  }
});

// ===========================================================================
// F. No empty gaps between present layers (no \n\n\n artifacts)
//
// When intermediate spec layers are absent, the separator must remain
// exactly \n\n.  An absent layer must NOT leave a blank slot that
// produces \n\n\n or additional blank lines.
// ===========================================================================

describe('F. No empty gaps between present layers', () => {
  it('F1. L1 and L7 (5 absent layers) — output has no \\n\\n\\n', () => {
    const result = assemblePrompt(sparseRequest('BlockAI', [SPARSE.sl, SPARSE.ins]));
    expect(result).not.toContain('\n\n\n');
    expect(result).toBe(`${SPARSE.sl}\n\n${SPARSE.ins}`);
  });

  it('F2. L1, L5, L7 (3 absent layers) — exactly 2 \\n\\n, no triple', () => {
    const result = assemblePrompt(sparseRequest('SideChat', [SPARSE.sl, SPARSE.q, SPARSE.ins]));
    expect(result).not.toContain('\n\n\n');
    const seps = (result.match(/\n\n/g) ?? []).length;
    expect(seps).toBe(2);
  });

  it('F3. L2, L4, L6 (alternating absent layers) — no triple newline', () => {
    const result = assemblePrompt(sparseRequest('BottomChat', [SPARSE.ow, SPARSE.sf, SPARSE.doc]));
    expect(result).not.toContain('\n\n\n');
    const seps = (result.match(/\n\n/g) ?? []).length;
    expect(seps).toBe(2);
  });

  it('F4. L1, L2 only (5 absent) — separator is exactly \\n\\n once', () => {
    const result = assemblePrompt(sparseRequest('QualityDial', [SPARSE.sl, SPARSE.ow]));
    expect(result).toBe(`${SPARSE.sl}\n\n${SPARSE.ow}`);
    expect(result).not.toContain('\n\n\n');
  });

  it('F5. L6, L7 only (5 absent) — output has one separator only', () => {
    const result = assemblePrompt(sparseRequest('BlockAI', [SPARSE.doc, SPARSE.ins]));
    expect(result).toBe(`${SPARSE.doc}\n\n${SPARSE.ins}`);
    expect(result).not.toContain('\n\n\n');
  });

  it('F6. L1, L4, L5, L7 (skip 2, 3, 6) — no triple newline', () => {
    const result = assemblePrompt(sparseRequest('SideChat', [SPARSE.sl, SPARSE.sf, SPARSE.q, SPARSE.ins]));
    expect(result).not.toContain('\n\n\n');
    const seps = (result.match(/\n\n/g) ?? []).length;
    expect(seps).toBe(3);
  });

  it('F7. all 5-layer leave-one-out cases produce no triple newline', () => {
    const ALL_SIX = [SPARSE.sl, SPARSE.ow, SPARSE.sf, SPARSE.q, SPARSE.doc, SPARSE.ins];
    for (const omitIdx of [0, 1, 2, 3, 4, 5]) {
      const tokens = ALL_SIX.filter((_, i) => i !== omitIdx);
      const result = assemblePrompt(sparseRequest('BlockAI', tokens));
      expect(result).not.toContain('\n\n\n');
    }
  });
});

// ===========================================================================
// G. Explicit empty fields behave identically to absent fields
//
// Passing an explicit '' for a layer field must have the same effect as
// omitting the field entirely — the layer is not emitted and the ordering
// of present layers is unaffected.
// ===========================================================================

describe('G. Explicit empty fields identical to absent fields', () => {
  it('G1. explicitly empty systemlaw ≡ absent systemlaw (owner + instruction present)', () => {
    const withEmpty = assemblePrompt({
      surface:          'BlockAI',
      systemlawContent: '',  // explicit empty
      ownerContent:     SPARSE.ow,
      userInstruction:  SPARSE.ins,
    });
    const withAbsent = assemblePrompt({
      surface:         'BlockAI',
      ownerContent:    SPARSE.ow,
      userInstruction: SPARSE.ins,
    });
    expect(withEmpty).toBe(withAbsent);
    expect(withEmpty).toBe(`${SPARSE.ow}\n\n${SPARSE.ins}`);
  });

  it('G2. explicitly empty owner ≡ absent owner (systemlaw + surface present)', () => {
    const withEmpty = assemblePrompt({
      surface:          'SideChat',
      systemlawContent: SPARSE.sl,
      ownerContent:     '',  // explicit empty
      surfacePrompt:    SPARSE.sf,
    });
    const withAbsent = assemblePrompt({
      surface:          'SideChat',
      systemlawContent: SPARSE.sl,
      surfacePrompt:    SPARSE.sf,
    });
    expect(withEmpty).toBe(withAbsent);
    expect(withEmpty).toBe(`${SPARSE.sl}\n\n${SPARSE.sf}`);
  });

  it('G3. whitespace-only quality ≡ absent quality (systemlaw + instruction present)', () => {
    const withWs = assemblePrompt({
      surface:          'BottomChat',
      systemlawContent: SPARSE.sl,
      qualityDirective: '   \n  ',  // whitespace-only
      userInstruction:  SPARSE.ins,
    });
    const withAbsent = assemblePrompt({
      surface:          'BottomChat',
      systemlawContent: SPARSE.sl,
      userInstruction:  SPARSE.ins,
    });
    expect(withWs).toBe(withAbsent);
    expect(withWs).toBe(`${SPARSE.sl}\n\n${SPARSE.ins}`);
  });

  it('G4. multiple explicit empty fields — only the non-empty ones appear, in spec order', () => {
    const result = assemblePrompt({
      surface:          'QualityDial',
      systemlawContent: '',      // empty
      ownerContent:     SPARSE.ow,
      surfacePrompt:    '',      // empty
      qualityDirective: SPARSE.q,
      documentText:     '',      // empty
      userInstruction:  SPARSE.ins,
    });
    // Only ow, q, ins should be present — in spec order
    expect(result).toContain(SPARSE.ow);
    expect(result).toContain(SPARSE.q);
    expect(result).toContain(SPARSE.ins);
    expect(result).not.toContain(SPARSE.sl);
    expect(result).not.toContain(SPARSE.sf);
    expect(result).not.toContain(SPARSE.doc);
    assertOrder(result, SPARSE.ow, SPARSE.q);
    assertOrder(result, SPARSE.q, SPARSE.ins);
    expect(result).toBe(`${SPARSE.ow}\n\n${SPARSE.q}\n\n${SPARSE.ins}`);
  });

  it('G5. all fields explicitly empty → empty string (no crash)', () => {
    const result = assemblePrompt({
      surface:          'BlockAI',
      systemlawContent: '',
      ownerContent:     '',
      surfacePrompt:    '',
      qualityDirective: '',
      documentText:     '',
      userInstruction:  '',
    });
    expect(result).toBe('');
  });
});

// ===========================================================================
// H. Sparse inputs spanning non-adjacent spec positions (large rank gaps)
//
// These tests specifically target cases where the rank gap between two
// present layers is 2 or more spec positions.  This directly validates the
// "no positional gaps violating rank precedence" claim in the Sub-AC.
// ===========================================================================

describe('H. Large-rank-gap sparse inputs', () => {
  it('H1. L1 and L7 — rank gap of 6 (spec positions 0 and 6)', () => {
    const result = assemblePrompt(sparseRequest('BlockAI', [SPARSE.sl, SPARSE.ins]));
    assertOrder(result, SPARSE.sl, SPARSE.ins);
    expect(result).toBe(`${SPARSE.sl}\n\n${SPARSE.ins}`);
  });

  it('H2. L1 and L6 — rank gap of 5 (spec positions 0 and 5)', () => {
    const result = assemblePrompt(sparseRequest('SideChat', [SPARSE.sl, SPARSE.doc]));
    assertOrder(result, SPARSE.sl, SPARSE.doc);
    expect(result).toBe(`${SPARSE.sl}\n\n${SPARSE.doc}`);
  });

  it('H3. L1 and L5 — rank gap of 4 (spec positions 0 and 4)', () => {
    const result = assemblePrompt(sparseRequest('BottomChat', [SPARSE.sl, SPARSE.q]));
    assertOrder(result, SPARSE.sl, SPARSE.q);
    expect(result).toBe(`${SPARSE.sl}\n\n${SPARSE.q}`);
  });

  it('H4. L1 and L4 — rank gap of 3 (spec positions 0 and 3)', () => {
    const result = assemblePrompt(sparseRequest('QualityDial', [SPARSE.sl, SPARSE.sf]));
    assertOrder(result, SPARSE.sl, SPARSE.sf);
    expect(result).toBe(`${SPARSE.sl}\n\n${SPARSE.sf}`);
  });

  it('H5. L2 and L7 — rank gap of 5 (spec positions 1 and 6)', () => {
    const result = assemblePrompt(sparseRequest('BlockAI', [SPARSE.ow, SPARSE.ins]));
    assertOrder(result, SPARSE.ow, SPARSE.ins);
    expect(result).toBe(`${SPARSE.ow}\n\n${SPARSE.ins}`);
  });

  it('H6. L2 and L6 — rank gap of 4 (spec positions 1 and 5)', () => {
    const result = assemblePrompt(sparseRequest('SideChat', [SPARSE.ow, SPARSE.doc]));
    assertOrder(result, SPARSE.ow, SPARSE.doc);
    expect(result).toBe(`${SPARSE.ow}\n\n${SPARSE.doc}`);
  });

  it('H7. L4 and L7 — rank gap of 3 (spec positions 3 and 6)', () => {
    const result = assemblePrompt(sparseRequest('BottomChat', [SPARSE.sf, SPARSE.ins]));
    assertOrder(result, SPARSE.sf, SPARSE.ins);
    expect(result).toBe(`${SPARSE.sf}\n\n${SPARSE.ins}`);
  });

  it('H8. L1, L4, L7 — two rank gaps of 3 and 3 (positions 0, 3, 6)', () => {
    const result = assemblePrompt(sparseRequest('QualityDial', [SPARSE.sl, SPARSE.sf, SPARSE.ins]));
    assertOrder(result, SPARSE.sl, SPARSE.sf);
    assertOrder(result, SPARSE.sf, SPARSE.ins);
    assertOrder(result, SPARSE.sl, SPARSE.ins);
    expect(result).toBe(`${SPARSE.sl}\n\n${SPARSE.sf}\n\n${SPARSE.ins}`);
  });

  it('H9. L1, L2, L7 — adjacent pair then rank gap of 5 (positions 0, 1, 6)', () => {
    const result = assemblePrompt(sparseRequest('BlockAI', [SPARSE.sl, SPARSE.ow, SPARSE.ins]));
    assertOrder(result, SPARSE.sl, SPARSE.ow);
    assertOrder(result, SPARSE.ow, SPARSE.ins);
    assertOrder(result, SPARSE.sl, SPARSE.ins);
    expect(result).toBe(`${SPARSE.sl}\n\n${SPARSE.ow}\n\n${SPARSE.ins}`);
  });

  it('H10. L2, L4, L7 — gaps of 2 and 3 (spec positions 1, 3, 6)', () => {
    const result = assemblePrompt(sparseRequest('SideChat', [SPARSE.ow, SPARSE.sf, SPARSE.ins]));
    assertOrder(result, SPARSE.ow, SPARSE.sf);
    assertOrder(result, SPARSE.sf, SPARSE.ins);
    assertOrder(result, SPARSE.ow, SPARSE.ins);
  });

  it('H11. output positions strictly increase by spec rank for all large-gap pairs', () => {
    // Combine tokens with maximum spread: L1, L5, L7 (gaps of 4, 2)
    const tokens = [SPARSE.sl, SPARSE.q, SPARSE.ins];
    const result = assemblePrompt(sparseRequest('BlockAI', tokens));

    // Get positions by spec rank order
    const orderedTokens = LAYER_RANK_ORDER.filter((t) => tokens.includes(t));
    const positions     = orderedTokens.map((t) => result.indexOf(t));

    // Every position must be found
    expect(positions.every((p) => p >= 0)).toBe(true);
    // Strictly increasing (rank preserved despite gaps)
    for (let i = 1; i < positions.length; i++) {
      expect(positions[i]).toBeGreaterThan(positions[i - 1]);
    }
  });
});

// ===========================================================================
// I. Single-layer degenerate-sparse cases
//
// When only one layer is supplied, the output is exactly that layer's
// content with no separators.  This is the minimal sparse case and
// confirms the function degrades gracefully to a single-token output.
// ===========================================================================

describe('I. Single-layer degenerate-sparse cases', () => {
  const SINGLE_LAYER_CASES: Array<[AssemblyRequest, string, string]> = [
    [{ surface: 'BlockAI',    systemlawContent: SPARSE.sl },  SPARSE.sl,  'L1 only'],
    [{ surface: 'SideChat',   ownerContent: SPARSE.ow },       SPARSE.ow,  'L2 only'],
    [{ surface: 'BottomChat', surfacePrompt: SPARSE.sf },      SPARSE.sf,  'L4 only'],
    [{ surface: 'QualityDial', qualityDirective: SPARSE.q },   SPARSE.q,   'L5 only'],
    [{ surface: 'BlockAI',    documentText: SPARSE.doc },      SPARSE.doc, 'L6 only'],
    [{ surface: 'SideChat',   userInstruction: SPARSE.ins },   SPARSE.ins, 'L7 only'],
  ];

  for (const [req, expected, desc] of SINGLE_LAYER_CASES) {
    it(`I — no throw: ${desc}`, () => {
      expect(() => assemblePrompt(req)).not.toThrow();
    });

    it(`I — output equals the single layer content verbatim: ${desc}`, () => {
      const result = assemblePrompt(req);
      expect(result).toBe(expected);
    });

    it(`I — output contains no separator: ${desc}`, () => {
      const result = assemblePrompt(req);
      expect(result).not.toContain('\n\n');
    });
  }
});

// ===========================================================================
// J. Surface-agnosticism for sparse inputs
//
// The same sparse content must produce the same assembled output regardless
// of which AI surface is specified.  Rank precedence is a content-only
// property, not a surface property.
// ===========================================================================

describe('J. Surface-agnosticism for sparse inputs', () => {
  it('J1. L1 + L7 produces identical output across all 4 surfaces', () => {
    const tokens  = [SPARSE.sl, SPARSE.ins];
    const results = SURFACES.map((s) => assemblePrompt(sparseRequest(s, tokens)));
    for (let i = 1; i < results.length; i++) {
      expect(results[i]).toBe(results[0]);
    }
  });

  it('J2. L2 + L5 + L7 produces identical output across all 4 surfaces', () => {
    const tokens  = [SPARSE.ow, SPARSE.q, SPARSE.ins];
    const results = SURFACES.map((s) => assemblePrompt(sparseRequest(s, tokens)));
    for (let i = 1; i < results.length; i++) {
      expect(results[i]).toBe(results[0]);
    }
  });

  it('J3. L1 + L4 + L6 + L7 produces identical output across all 4 surfaces', () => {
    const tokens  = [SPARSE.sl, SPARSE.sf, SPARSE.doc, SPARSE.ins];
    const results = SURFACES.map((s) => assemblePrompt(sparseRequest(s, tokens)));
    for (let i = 1; i < results.length; i++) {
      expect(results[i]).toBe(results[0]);
    }
  });

  it('J4. rank-precedence invariant is identical on all surfaces for a fixed sparse set', () => {
    const tokens = [SPARSE.sl, SPARSE.q, SPARSE.doc]; // L1, L5, L6
    for (const surface of SURFACES) {
      const result = assemblePrompt(sparseRequest(surface, tokens));
      assertAllPairsInRankOrder(result, tokens);
    }
  });
});
