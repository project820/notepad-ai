/**
 * assemble-7layer-order.test.ts
 *
 * Sub-AC 8.2: All 7 layer slots are populated with distinct synthetic strings
 * and the returned array/string places every segment in spec layer order
 * (layers 1 through 7, 1-indexed; positions 0-6 in code).
 *
 * Spec layer order (1-indexed per the AC, 0-indexed in code):
 *
 *   Layer 1 (pos 0) — systemlaw    userData/systemlaw.md
 *   Layer 2 (pos 1) — owner        userData/Owner.md
 *   Layer 3 (pos 2) — overview     Overview.md cascade (Phase 2 stub in Phase 1)
 *   Layer 4 (pos 3) — surface      Surface-specific system prompt
 *   Layer 5 (pos 4) — quality      Quality-dial directive
 *   Layer 6 (pos 5) — document     Document text / selection context
 *   Layer 7 (pos 6) — instruction  User's specific instruction
 *
 * Phase 1 note on layer 3 (overview):
 *   `assemblePrompt` hard-codes the overview slot to '' so that Phase 2 can
 *   plug in the cascade without touching Phase 1 surfaces.  The overview slot
 *   therefore cannot be populated via `assemblePrompt`; the full 7-layer
 *   ordering (all 7 distinct strings, all 7 positions) is verified through
 *   `orderLayers`, which is the underlying ordering primitive that
 *   `assemblePrompt` delegates to — and therefore qualifies as the
 *   "or equivalent" path stated in Sub-AC 8.2.
 *
 * Test groups:
 *   A. `orderLayers` — all 7 slots populated with distinct synthetic strings
 *      A1. Output array has exactly 7 elements
 *      A2. Output `kind` sequence matches spec layer order (1-7)
 *      A3. Each slot's distinct string is preserved at its spec position
 *      A4. Works when input is in reverse order (hardest shuffle)
 *      A5. Works for every permutation produced by rotating the input
 *      A6. No content is lost (all 7 distinct strings present in output)
 *      A7. No content is duplicated (each distinct string appears exactly once)
 *      A8. Content at position N is the synthetic string for spec layer N+1
 *
 *   B. `assemblePrompt` — 6 user-controllable slots with distinct synthetic
 *      strings (overview excluded: Phase 1 always emits it as '')
 *      B1. Output is a non-empty string
 *      B2. All 6 non-overview distinct strings appear in the output
 *      B3. Layer 1 (systemlaw) precedes layer 2 (owner)
 *      B4. Layer 2 (owner) precedes layer 4 (surface)
 *      B5. Layer 4 (surface) precedes layer 5 (quality)
 *      B6. Layer 5 (quality) precedes layer 6 (document)
 *      B7. Layer 6 (document) precedes layer 7 (instruction)
 *      B8. Full chain: every adjacent pair is in spec order
 *      B9. Layer 3 (overview) is absent from the output
 *      B10. Each distinct string appears exactly once in the output
 *      B11. `assemblePrompt` result matches manual join in spec layer order
 *
 *   C. Cross-verification — `orderLayers` and `assemblePrompt` consistency
 *      C1. `orderLayers` result (6 non-overview layers, joined) matches
 *          `assemblePrompt` output for the same input content
 *      C2. Distinct strings round-trip through assemble unchanged
 */

import { describe, it, expect } from 'vitest';
import { orderLayers, LAYER_KINDS, type PromptLayer } from '../../src/main/prompts/order';
import { assemblePrompt, type AssemblyRequest } from '../../src/main/prompts/assemble';

// ---------------------------------------------------------------------------
// Sub-AC 8.2 — Synthetic "slot label" strings
//
// Each string uniquely identifies its spec layer position (1-indexed, matching
// the Sub-AC description).  They are deliberately verbose so no two strings
// share a substring prefix, making indexOf assertions unambiguous.
// ---------------------------------------------------------------------------

/** Mapping from spec layer number (1-indexed) to the distinct synthetic string. */
const SLOT = {
  1: 'SPEC_LAYER_1_SYSTEMLAW_DISTINCT_CONTENT',
  2: 'SPEC_LAYER_2_OWNER_DISTINCT_CONTENT',
  3: 'SPEC_LAYER_3_OVERVIEW_DISTINCT_CONTENT',
  4: 'SPEC_LAYER_4_SURFACE_DISTINCT_CONTENT',
  5: 'SPEC_LAYER_5_QUALITY_DISTINCT_CONTENT',
  6: 'SPEC_LAYER_6_DOCUMENT_DISTINCT_CONTENT',
  7: 'SPEC_LAYER_7_INSTRUCTION_DISTINCT_CONTENT',
} as const;

/** All 7 distinct synthetic strings in spec layer order (layers 1–7). */
const ALL_SLOTS_IN_SPEC_ORDER = [
  SLOT[1], // Layer 1 — systemlaw   (position 0)
  SLOT[2], // Layer 2 — owner       (position 1)
  SLOT[3], // Layer 3 — overview    (position 2)
  SLOT[4], // Layer 4 — surface     (position 3)
  SLOT[5], // Layer 5 — quality     (position 4)
  SLOT[6], // Layer 6 — document    (position 5)
  SLOT[7], // Layer 7 — instruction (position 6)
] as const;

/** The canonical kind → content mapping for all 7 layers. */
const FULL_7_LAYER_INPUT: PromptLayer[] = [
  { kind: 'systemlaw',   content: SLOT[1] },
  { kind: 'owner',       content: SLOT[2] },
  { kind: 'overview',    content: SLOT[3] },
  { kind: 'surface',     content: SLOT[4] },
  { kind: 'quality',     content: SLOT[5] },
  { kind: 'document',    content: SLOT[6] },
  { kind: 'instruction', content: SLOT[7] },
];

/** The same 7 layers supplied in reverse order (hardest re-ordering case). */
const FULL_7_LAYER_REVERSED: PromptLayer[] = [
  { kind: 'instruction', content: SLOT[7] },
  { kind: 'document',    content: SLOT[6] },
  { kind: 'quality',     content: SLOT[5] },
  { kind: 'surface',     content: SLOT[4] },
  { kind: 'overview',    content: SLOT[3] },
  { kind: 'owner',       content: SLOT[2] },
  { kind: 'systemlaw',   content: SLOT[1] },
];

/** A non-trivial random permutation of the 7 layers. */
const FULL_7_LAYER_PERMUTED: PromptLayer[] = [
  { kind: 'quality',     content: SLOT[5] },
  { kind: 'systemlaw',   content: SLOT[1] },
  { kind: 'instruction', content: SLOT[7] },
  { kind: 'overview',    content: SLOT[3] },
  { kind: 'document',    content: SLOT[6] },
  { kind: 'owner',       content: SLOT[2] },
  { kind: 'surface',     content: SLOT[4] },
];

/**
 * Build an `AssemblyRequest` with all 6 user-controllable slots populated
 * using the distinct synthetic strings from SLOT[].
 * Layer 3 (overview) is intentionally absent — it cannot be set by callers
 * in Phase 1 (`assemblePrompt` always emits overview as '').
 */
function fullAssemblyRequest(): AssemblyRequest {
  return {
    surface:          'BlockAI',
    systemlawContent: SLOT[1], // Layer 1
    ownerContent:     SLOT[2], // Layer 2
    // overview is Layer 3 — not a field on AssemblyRequest in Phase 1
    surfacePrompt:    SLOT[4], // Layer 4
    qualityDirective: SLOT[5], // Layer 5
    documentText:     SLOT[6], // Layer 6
    userInstruction:  SLOT[7], // Layer 7
  };
}

/**
 * Assert that `earlier` appears before `later` in `text`.
 * Both strings must be present; earlier index must be strictly less than later.
 */
function assertOrder(text: string, earlier: string, later: string): void {
  const idxA = text.indexOf(earlier);
  const idxB = text.indexOf(later);
  expect(idxA).toBeGreaterThanOrEqual(0);
  expect(idxB).toBeGreaterThanOrEqual(0);
  expect(idxA).toBeLessThan(idxB);
}

// ===========================================================================
// A. `orderLayers` — all 7 slots populated with distinct synthetic strings
//
// `orderLayers` is the underlying primitive that `assemblePrompt` delegates to
// ("or equivalent" per Sub-AC 8.2).  By testing it with all 7 populated slots
// we satisfy the requirement that every segment—including Layer 3 (overview)
// which `assemblePrompt` hard-codes to ''—appears in spec layer order.
// ===========================================================================

describe('A. orderLayers — all 7 slots populated with distinct synthetic strings', () => {
  // Run the primary 7-layer ordering assertion on each permutation so that
  // the result is unambiguous (not an artifact of input order).

  const cases: Array<[string, PromptLayer[]]> = [
    ['already in spec order', FULL_7_LAYER_INPUT],
    ['reverse of spec order', FULL_7_LAYER_REVERSED],
    ['random permutation',    FULL_7_LAYER_PERMUTED],
  ];

  for (const [label, input] of cases) {
    describe(`input: ${label}`, () => {
      // Compute ordered result once per sub-case.
      const ordered = orderLayers(input);

      it('A1. output array has exactly 7 elements', () => {
        expect(ordered).toHaveLength(7);
      });

      it('A2. output `kind` sequence matches the 7-layer spec order', () => {
        const actualKinds = ordered.map((l) => l.kind);
        expect(actualKinds).toEqual([...LAYER_KINDS]); // ['systemlaw','owner','overview','surface','quality','document','instruction']
      });

      it('A3. layer 1 (systemlaw, pos 0) holds SLOT[1]', () => {
        expect(ordered[0].kind).toBe('systemlaw');
        expect(ordered[0].content).toBe(SLOT[1]);
      });

      it('A4. layer 2 (owner, pos 1) holds SLOT[2]', () => {
        expect(ordered[1].kind).toBe('owner');
        expect(ordered[1].content).toBe(SLOT[2]);
      });

      it('A5. layer 3 (overview, pos 2) holds SLOT[3]', () => {
        expect(ordered[2].kind).toBe('overview');
        expect(ordered[2].content).toBe(SLOT[3]);
      });

      it('A6. layer 4 (surface, pos 3) holds SLOT[4]', () => {
        expect(ordered[3].kind).toBe('surface');
        expect(ordered[3].content).toBe(SLOT[4]);
      });

      it('A7. layer 5 (quality, pos 4) holds SLOT[5]', () => {
        expect(ordered[4].kind).toBe('quality');
        expect(ordered[4].content).toBe(SLOT[5]);
      });

      it('A8. layer 6 (document, pos 5) holds SLOT[6]', () => {
        expect(ordered[5].kind).toBe('document');
        expect(ordered[5].content).toBe(SLOT[6]);
      });

      it('A9. layer 7 (instruction, pos 6) holds SLOT[7]', () => {
        expect(ordered[6].kind).toBe('instruction');
        expect(ordered[6].content).toBe(SLOT[7]);
      });

      it('A10. all 7 distinct strings are present in the output (no content lost)', () => {
        const outputContents = ordered.map((l) => l.content);
        for (const slotContent of ALL_SLOTS_IN_SPEC_ORDER) {
          expect(outputContents).toContain(slotContent);
        }
      });

      it('A11. each distinct string appears exactly once (no duplication)', () => {
        const outputContents = ordered.map((l) => l.content);
        for (const slotContent of ALL_SLOTS_IN_SPEC_ORDER) {
          const count = outputContents.filter((c) => c === slotContent).length;
          expect(count).toBe(1);
        }
      });

      it('A12. joined output places every segment in spec layer order (1 through 7)', () => {
        // Join the ordered contents with the canonical separator and verify
        // that each SLOT string appears before the next in sequence.
        const joined = ordered.map((l) => l.content).join('\n\n');
        for (let i = 0; i < ALL_SLOTS_IN_SPEC_ORDER.length - 1; i++) {
          assertOrder(joined, ALL_SLOTS_IN_SPEC_ORDER[i], ALL_SLOTS_IN_SPEC_ORDER[i + 1]);
        }
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Additional cross-permutation invariant: `orderLayers` output content array
  // equals ALL_SLOTS_IN_SPEC_ORDER regardless of input permutation.
  // ---------------------------------------------------------------------------

  it('A13. output content array equals ALL_SLOTS_IN_SPEC_ORDER for any permutation', () => {
    const permutations = [FULL_7_LAYER_INPUT, FULL_7_LAYER_REVERSED, FULL_7_LAYER_PERMUTED];
    for (const perm of permutations) {
      const result = orderLayers(perm);
      expect(result.map((l) => l.content)).toEqual([...ALL_SLOTS_IN_SPEC_ORDER]);
    }
  });

  it('A14. position of each slot string in the joined output strictly increases (spec order)', () => {
    const ordered = orderLayers(FULL_7_LAYER_PERMUTED);
    const joined  = ordered.map((l) => l.content).join('\n\n');
    const positions = ALL_SLOTS_IN_SPEC_ORDER.map((s) => joined.indexOf(s));
    // No slot string should be absent
    expect(positions.every((p) => p >= 0)).toBe(true);
    // Each position must be strictly greater than the previous
    for (let i = 1; i < positions.length; i++) {
      expect(positions[i]).toBeGreaterThan(positions[i - 1]);
    }
  });
});

// ===========================================================================
// B. `assemblePrompt` — 6 user-controllable slots with distinct synthetic strings
//
// Layer 3 (overview) is excluded: `assemblePrompt` hard-codes it to '' in
// Phase 1 so the Phase 2 cascade can plug in without modifying Phase 1 surfaces.
// The 6 remaining layers (1, 2, 4, 5, 6, 7) are populated with the SLOT[]
// distinct synthetic strings and the output string is asserted to place every
// one of them in spec layer order.
// ===========================================================================

describe('B. assemblePrompt — 6 distinct synthetic strings in spec layer order', () => {
  const req    = fullAssemblyRequest();
  const result = assemblePrompt(req);

  /** The 6 synthetic strings in the order they should appear in the output. */
  const SIX_SLOTS_IN_SPEC_ORDER = [
    SLOT[1], // Layer 1 — systemlaw
    SLOT[2], // Layer 2 — owner
    // SLOT[3] (overview) is absent — Phase 1 stub always ''
    SLOT[4], // Layer 4 — surface
    SLOT[5], // Layer 5 — quality
    SLOT[6], // Layer 6 — document
    SLOT[7], // Layer 7 — instruction
  ] as const;

  it('B1. output is a non-empty string', () => {
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('B2. SLOT[1] (layer 1 — systemlaw) is present in output', () => {
    expect(result).toContain(SLOT[1]);
  });

  it('B3. SLOT[2] (layer 2 — owner) is present in output', () => {
    expect(result).toContain(SLOT[2]);
  });

  it('B4. SLOT[4] (layer 4 — surface) is present in output', () => {
    expect(result).toContain(SLOT[4]);
  });

  it('B5. SLOT[5] (layer 5 — quality) is present in output', () => {
    expect(result).toContain(SLOT[5]);
  });

  it('B6. SLOT[6] (layer 6 — document) is present in output', () => {
    expect(result).toContain(SLOT[6]);
  });

  it('B7. SLOT[7] (layer 7 — instruction) is present in output', () => {
    expect(result).toContain(SLOT[7]);
  });

  it('B8. all 6 distinct synthetic strings are present in the output', () => {
    for (const s of SIX_SLOTS_IN_SPEC_ORDER) {
      expect(result).toContain(s);
    }
  });

  it('B9. layer 1 (systemlaw) precedes layer 2 (owner) in output', () => {
    assertOrder(result, SLOT[1], SLOT[2]);
  });

  it('B10. layer 2 (owner) precedes layer 4 (surface) in output', () => {
    assertOrder(result, SLOT[2], SLOT[4]);
  });

  it('B11. layer 4 (surface) precedes layer 5 (quality) in output', () => {
    assertOrder(result, SLOT[4], SLOT[5]);
  });

  it('B12. layer 5 (quality) precedes layer 6 (document) in output', () => {
    assertOrder(result, SLOT[5], SLOT[6]);
  });

  it('B13. layer 6 (document) precedes layer 7 (instruction) in output', () => {
    assertOrder(result, SLOT[6], SLOT[7]);
  });

  it('B14. full chain: every adjacent pair of spec layers is in order (1→2→4→5→6→7)', () => {
    for (let i = 0; i < SIX_SLOTS_IN_SPEC_ORDER.length - 1; i++) {
      assertOrder(result, SIX_SLOTS_IN_SPEC_ORDER[i], SIX_SLOTS_IN_SPEC_ORDER[i + 1]);
    }
  });

  it('B15. layer 3 (overview) distinct string is absent from output (Phase 1 stub)', () => {
    // SLOT[3] cannot be injected via assemblePrompt in Phase 1.
    expect(result).not.toContain(SLOT[3]);
  });

  it('B16. each distinct string appears exactly once in the output (no duplication)', () => {
    for (const s of SIX_SLOTS_IN_SPEC_ORDER) {
      const count = (result.match(new RegExp(s, 'g')) ?? []).length;
      expect(count).toBe(1);
    }
  });

  it('B17. position of each slot string strictly increases in spec layer order', () => {
    const positions = SIX_SLOTS_IN_SPEC_ORDER.map((s) => result.indexOf(s));
    // All must be found
    expect(positions.every((p) => p >= 0)).toBe(true);
    // Strictly increasing (spec order)
    for (let i = 1; i < positions.length; i++) {
      expect(positions[i]).toBeGreaterThan(positions[i - 1]);
    }
  });

  it('B18. output equals manual join of 6 slots in spec layer order with \\n\\n separator', () => {
    const expected = SIX_SLOTS_IN_SPEC_ORDER.join('\n\n');
    expect(result).toBe(expected);
  });

  it('B19. assemblePrompt result is the same across all four AI surfaces for identical content', () => {
    const surfaces = ['BlockAI', 'SideChat', 'BottomChat', 'QualityDial'] as const;
    const results = surfaces.map((surface) => assemblePrompt({ ...req, surface }));
    for (let i = 1; i < results.length; i++) {
      expect(results[i]).toBe(results[0]);
    }
  });

  it('B20. assemblePrompt never throws when called with all 6 distinct slots', () => {
    expect(() => assemblePrompt(req)).not.toThrow();
  });
});

// ===========================================================================
// C. Cross-verification — `orderLayers` and `assemblePrompt` consistency
//
// The ordered output from `orderLayers` (filtered to non-empty layers and
// joined with '\n\n') must equal the `assemblePrompt` output for the same
// 6-layer content — confirming both functions agree on the spec layer order.
// ===========================================================================

describe('C. Cross-verification — orderLayers and assemblePrompt consistency', () => {
  it('C1. orderLayers (6 non-overview layers) joined equals assemblePrompt result', () => {
    // Build the same 6 layers as fullAssemblyRequest(), but skip overview.
    const sixLayers: PromptLayer[] = [
      { kind: 'systemlaw',   content: SLOT[1] },
      { kind: 'owner',       content: SLOT[2] },
      // overview intentionally omitted to match assemblePrompt Phase 1 behavior
      { kind: 'surface',     content: SLOT[4] },
      { kind: 'quality',     content: SLOT[5] },
      { kind: 'document',    content: SLOT[6] },
      { kind: 'instruction', content: SLOT[7] },
    ];

    // orderLayers sorts and returns them; all are non-empty so nothing is filtered.
    const ordered = orderLayers(sixLayers);
    const joinedFromOrderLayers = ordered
      .filter((l) => l.content.trim().length > 0)
      .map((l) => l.content)
      .join('\n\n');

    const fromAssemblePrompt = assemblePrompt(fullAssemblyRequest());

    expect(joinedFromOrderLayers).toBe(fromAssemblePrompt);
  });

  it('C2. orderLayers (7 layers including overview with SLOT[3]) joined matches manual spec-order join', () => {
    const ordered = orderLayers(FULL_7_LAYER_INPUT);
    const joined  = ordered.map((l) => l.content).join('\n\n');

    // The joined string must equal the manual join of all 7 slots in spec order.
    const expected = ALL_SLOTS_IN_SPEC_ORDER.join('\n\n');
    expect(joined).toBe(expected);
  });

  it('C3. distinct synthetic strings survive the round-trip through both functions unchanged', () => {
    // Via orderLayers
    const orderedResult = orderLayers(FULL_7_LAYER_PERMUTED);
    for (const slotContent of ALL_SLOTS_IN_SPEC_ORDER) {
      expect(orderedResult.some((l) => l.content === slotContent)).toBe(true);
    }

    // Via assemblePrompt (6 user-controllable slots)
    const assembled = assemblePrompt(fullAssemblyRequest());
    const sixSlots  = [SLOT[1], SLOT[2], SLOT[4], SLOT[5], SLOT[6], SLOT[7]] as const;
    for (const slotContent of sixSlots) {
      expect(assembled).toContain(slotContent);
    }
  });

  it('C4. no slot string is modified, trimmed, or corrupted through either function', () => {
    // orderLayers path
    const orderedContents = orderLayers(FULL_7_LAYER_INPUT).map((l) => l.content);
    expect(orderedContents).toEqual([...ALL_SLOTS_IN_SPEC_ORDER]);

    // assemblePrompt path — verify each slot string is embedded verbatim
    const assembled = assemblePrompt(fullAssemblyRequest());
    const sixSlots  = [SLOT[1], SLOT[2], SLOT[4], SLOT[5], SLOT[6], SLOT[7]] as const;
    for (const slotContent of sixSlots) {
      // The exact string must appear as a substring; no partial match
      expect(assembled.includes(slotContent)).toBe(true);
    }
  });
});
