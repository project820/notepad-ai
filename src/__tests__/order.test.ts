/**
 * order.test.ts
 *
 * Unit tests for `orderLayers` and `layerPosition` (src/main/prompts/order.ts).
 *
 * Sub-AC 1.1 requirements:
 *   ✓ All valid layer positions (all 7 known kinds)
 *   ✓ Unknown-layer handling (unknown kinds → end of list)
 *   ✓ Stable ordering when positions are equal
 *   ✓ Pure function — input array is never mutated
 *   ✓ Empty array returns empty array
 *   ✓ Single-element array
 *   ✓ Already-sorted input remains sorted
 *   ✓ Reverse-sorted input becomes sorted
 *
 * Test groups:
 *   A. `layerPosition` helper — position values for each known kind
 *   B. `layerPosition` helper — unknown kind → Infinity
 *   C. `orderLayers` — empty input
 *   D. `orderLayers` — single element
 *   E. `orderLayers` — all 7 known kinds, already in order
 *   F. `orderLayers` — all 7 known kinds, reverse order
 *   G. `orderLayers` — all 7 known kinds, random permutation
 *   H. `orderLayers` — unknown kinds appear after all known kinds
 *   I. `orderLayers` — stable ordering: equal positions preserve insertion order
 *   J. `orderLayers` — pure function: original array not mutated
 *   K. `orderLayers` — layers with extra metadata fields are preserved
 *   L. `orderLayers` — mix of known and unknown kinds
 *   M. `orderLayers` — duplicate kinds at same position, stable order
 *   N. `orderLayers` — multiple unknown kinds preserve their relative order
 *   O. `LAYER_KINDS` export — all 7 entries present, in schema order
 */

import { describe, it, expect } from 'vitest';
import {
  orderLayers,
  layerPosition,
  LAYER_KINDS,
  type PromptLayer,
  type LayerKind,
} from '../../src/main/prompts/order';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal PromptLayer. */
function layer(kind: string, content = '', extra?: Record<string, unknown>): PromptLayer {
  return { kind, content, ...extra };
}

/** Return just the `kind` strings from a sorted array, for concise assertions. */
function kinds(layers: PromptLayer[]): string[] {
  return layers.map((l) => l.kind);
}

// ---------------------------------------------------------------------------
// A. layerPosition — known kinds
// ---------------------------------------------------------------------------

describe('A. layerPosition — known kinds', () => {
  it('A1. systemlaw is position 0', () => {
    expect(layerPosition('systemlaw')).toBe(0);
  });

  it('A2. owner is position 1', () => {
    expect(layerPosition('owner')).toBe(1);
  });

  it('A3. overview is position 2', () => {
    expect(layerPosition('overview')).toBe(2);
  });

  it('A4. surface is position 3', () => {
    expect(layerPosition('surface')).toBe(3);
  });

  it('A5. quality is position 4', () => {
    expect(layerPosition('quality')).toBe(4);
  });

  it('A6. document is position 5', () => {
    expect(layerPosition('document')).toBe(5);
  });

  it('A7. instruction is position 6', () => {
    expect(layerPosition('instruction')).toBe(6);
  });

  it('A8. all 7 positions are unique', () => {
    const positions = LAYER_KINDS.map(layerPosition);
    const unique = new Set(positions);
    expect(unique.size).toBe(7);
  });

  it('A9. positions form a contiguous 0–6 range', () => {
    const positions = LAYER_KINDS.map(layerPosition).sort((a, b) => a - b);
    expect(positions).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });
});

// ---------------------------------------------------------------------------
// B. layerPosition — unknown kinds
// ---------------------------------------------------------------------------

describe('B. layerPosition — unknown kinds', () => {
  it('B1. empty string → Infinity', () => {
    expect(layerPosition('')).toBe(Infinity);
  });

  it('B2. arbitrary string → Infinity', () => {
    expect(layerPosition('foobar')).toBe(Infinity);
  });

  it('B3. UPPER-CASE known kind → Infinity (case-sensitive)', () => {
    expect(layerPosition('SYSTEMLAW')).toBe(Infinity);
  });

  it('B4. partial match → Infinity', () => {
    expect(layerPosition('system')).toBe(Infinity);
  });

  it('B5. numeric string → Infinity', () => {
    expect(layerPosition('0')).toBe(Infinity);
  });

  it('B6. "context" (non-schema word) → Infinity', () => {
    expect(layerPosition('context')).toBe(Infinity);
  });
});

// ---------------------------------------------------------------------------
// C. orderLayers — empty input
// ---------------------------------------------------------------------------

describe('C. orderLayers — empty input', () => {
  it('C1. empty array → empty array', () => {
    expect(orderLayers([])).toEqual([]);
  });

  it('C2. result is an array', () => {
    expect(Array.isArray(orderLayers([]))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// D. orderLayers — single element
// ---------------------------------------------------------------------------

describe('D. orderLayers — single element', () => {
  it('D1. single known layer passes through', () => {
    const input = [layer('systemlaw', 'rules')];
    const result = orderLayers(input);
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe('systemlaw');
    expect(result[0].content).toBe('rules');
  });

  it('D2. single unknown layer passes through', () => {
    const input = [layer('mystery', 'content')];
    const result = orderLayers(input);
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe('mystery');
  });
});

// ---------------------------------------------------------------------------
// E. orderLayers — all 7 known kinds, already in order
// ---------------------------------------------------------------------------

describe('E. orderLayers — already in canonical order', () => {
  const input: PromptLayer[] = [
    layer('systemlaw',   'sl'),
    layer('owner',       'ow'),
    layer('overview',    'ov'),
    layer('surface',     'sf'),
    layer('quality',     'q'),
    layer('document',    'doc'),
    layer('instruction', 'ins'),
  ];

  it('E1. output has 7 elements', () => {
    expect(orderLayers(input)).toHaveLength(7);
  });

  it('E2. order is unchanged when already canonical', () => {
    expect(kinds(orderLayers(input))).toEqual([
      'systemlaw', 'owner', 'overview', 'surface', 'quality', 'document', 'instruction',
    ]);
  });

  it('E3. content is preserved', () => {
    const result = orderLayers(input);
    expect(result[0].content).toBe('sl');
    expect(result[6].content).toBe('ins');
  });
});

// ---------------------------------------------------------------------------
// F. orderLayers — all 7 known kinds, reverse order
// ---------------------------------------------------------------------------

describe('F. orderLayers — reverse input produces canonical order', () => {
  const input: PromptLayer[] = [
    layer('instruction', 'ins'),
    layer('document',    'doc'),
    layer('quality',     'q'),
    layer('surface',     'sf'),
    layer('overview',    'ov'),
    layer('owner',       'ow'),
    layer('systemlaw',   'sl'),
  ];

  it('F1. output is in canonical order', () => {
    expect(kinds(orderLayers(input))).toEqual([
      'systemlaw', 'owner', 'overview', 'surface', 'quality', 'document', 'instruction',
    ]);
  });

  it('F2. content still matches after sorting', () => {
    const result = orderLayers(input);
    expect(result[0].content).toBe('sl');
    expect(result[1].content).toBe('ow');
    expect(result[6].content).toBe('ins');
  });
});

// ---------------------------------------------------------------------------
// G. orderLayers — random permutation
// ---------------------------------------------------------------------------

describe('G. orderLayers — random permutation', () => {
  // Permutation: quality, instruction, systemlaw, document, owner, surface, overview
  const input: PromptLayer[] = [
    layer('quality',     'q'),
    layer('instruction', 'ins'),
    layer('systemlaw',   'sl'),
    layer('document',    'doc'),
    layer('owner',       'ow'),
    layer('surface',     'sf'),
    layer('overview',    'ov'),
  ];

  it('G1. output is in canonical order regardless of input order', () => {
    expect(kinds(orderLayers(input))).toEqual([
      'systemlaw', 'owner', 'overview', 'surface', 'quality', 'document', 'instruction',
    ]);
  });
});

// ---------------------------------------------------------------------------
// H. orderLayers — unknown kinds appear after all known kinds
// ---------------------------------------------------------------------------

describe('H. orderLayers — unknown kinds land after known kinds', () => {
  it('H1. single unknown kind follows all known kinds', () => {
    const input = [
      layer('instruction', 'ins'),
      layer('mystery',     'x'),
      layer('systemlaw',   'sl'),
    ];
    const result = kinds(orderLayers(input));
    expect(result).toEqual(['systemlaw', 'instruction', 'mystery']);
  });

  it('H2. multiple unknown kinds all appear after known kinds', () => {
    const input = [
      layer('alpha',     'a'),
      layer('surface',   'sf'),
      layer('beta',      'b'),
      layer('document',  'doc'),
      layer('gamma',     'g'),
    ];
    const result = kinds(orderLayers(input));
    expect(result.slice(0, 2)).toEqual(['surface', 'document']);
    expect(result.slice(2)).toEqual(expect.arrayContaining(['alpha', 'beta', 'gamma']));
  });

  it('H3. unknown kind does not throw', () => {
    expect(() => orderLayers([layer('__unknown__', 'u')])).not.toThrow();
  });

  it('H4. empty-string kind is treated as unknown', () => {
    const input = [layer('', 'empty'), layer('quality', 'q')];
    const result = kinds(orderLayers(input));
    expect(result).toEqual(['quality', '']);
  });
});

// ---------------------------------------------------------------------------
// I. orderLayers — stable ordering: equal positions preserve insertion order
// ---------------------------------------------------------------------------

describe('I. orderLayers — stable sort for equal positions', () => {
  it('I1. two layers of the same known kind keep insertion order', () => {
    const input = [
      layer('quality', 'first-q'),
      layer('quality', 'second-q'),
    ];
    const result = orderLayers(input);
    expect(result[0].content).toBe('first-q');
    expect(result[1].content).toBe('second-q');
  });

  it('I2. three layers of the same known kind keep insertion order', () => {
    const input = [
      layer('document', 'doc-1'),
      layer('document', 'doc-2'),
      layer('document', 'doc-3'),
    ];
    const result = orderLayers(input);
    expect(result.map((l) => l.content)).toEqual(['doc-1', 'doc-2', 'doc-3']);
  });

  it('I3. multiple unknown kinds preserve their relative order', () => {
    const input = [
      layer('zzz', 'first-unknown'),
      layer('aaa', 'second-unknown'),
      layer('mmm', 'third-unknown'),
    ];
    const result = orderLayers(input);
    // All unknown → all at end, relative order preserved
    expect(result.map((l) => l.content)).toEqual([
      'first-unknown',
      'second-unknown',
      'third-unknown',
    ]);
  });

  it('I4. mixed: known in order + two duplicate unknown kinds', () => {
    const input = [
      layer('systemlaw', 'sl'),
      layer('extra',     'e1'),
      layer('owner',     'ow'),
      layer('extra',     'e2'),
    ];
    const result = orderLayers(input);
    expect(result[0].kind).toBe('systemlaw');
    expect(result[1].kind).toBe('owner');
    expect(result[2].content).toBe('e1');
    expect(result[3].content).toBe('e2');
  });
});

// ---------------------------------------------------------------------------
// J. orderLayers — pure function: input not mutated
// ---------------------------------------------------------------------------

describe('J. orderLayers — pure function / no mutation', () => {
  it('J1. original array reference is unchanged', () => {
    const input: PromptLayer[] = [
      layer('instruction', 'ins'),
      layer('systemlaw',   'sl'),
    ];
    const snapshot = [...input];
    orderLayers(input);
    expect(input).toEqual(snapshot);
  });

  it('J2. original array length is unchanged', () => {
    const input = [layer('quality', 'q'), layer('owner', 'ow')];
    orderLayers(input);
    expect(input).toHaveLength(2);
  });

  it('J3. individual layer objects are not mutated', () => {
    const sl = layer('systemlaw', 'sl');
    const ins = layer('instruction', 'ins');
    orderLayers([ins, sl]);
    expect(sl.kind).toBe('systemlaw');
    expect(ins.kind).toBe('instruction');
  });

  it('J4. returns a new array (not the same reference)', () => {
    const input = [layer('quality', 'q')];
    const result = orderLayers(input);
    expect(result).not.toBe(input);
  });
});

// ---------------------------------------------------------------------------
// K. orderLayers — extra metadata fields are preserved
// ---------------------------------------------------------------------------

describe('K. orderLayers — extra metadata fields are preserved', () => {
  it('K1. sourcePath field survives ordering', () => {
    const input = [
      layer('instruction', 'ins', { sourcePath: '/tmp/foo.md' }),
      layer('systemlaw', 'sl', { sourcePath: '/userData/systemlaw.md' }),
    ];
    const result = orderLayers(input);
    expect(result[0].sourcePath).toBe('/userData/systemlaw.md');
    expect(result[1].sourcePath).toBe('/tmp/foo.md');
  });

  it('K2. arbitrary extra field is passed through', () => {
    const input = [layer('quality', 'q', { hash: 'abc123', version: 2 })];
    const result = orderLayers(input);
    expect(result[0].hash).toBe('abc123');
    expect(result[0].version).toBe(2);
  });

  it('K3. content is preserved exactly (no trimming or modification)', () => {
    const content = '  leading and trailing spaces  \n\n';
    const input = [layer('surface', content)];
    expect(orderLayers(input)[0].content).toBe(content);
  });
});

// ---------------------------------------------------------------------------
// L. orderLayers — mix of known and unknown kinds
// ---------------------------------------------------------------------------

describe('L. orderLayers — mixed known/unknown input', () => {
  it('L1. known kinds always precede unknown kinds', () => {
    const input = [
      layer('unknown-x',   'x'),
      layer('quality',     'q'),
      layer('unknown-y',   'y'),
      layer('systemlaw',   'sl'),
    ];
    const result = orderLayers(input);
    const knownPositions = result
      .map((l, i) => ({ kind: l.kind, i }))
      .filter((e) => LAYER_KINDS.includes(e.kind as LayerKind))
      .map((e) => e.i);
    const unknownPositions = result
      .map((l, i) => ({ kind: l.kind, i }))
      .filter((e) => !LAYER_KINDS.includes(e.kind as LayerKind))
      .map((e) => e.i);
    expect(Math.max(...knownPositions)).toBeLessThan(Math.min(...unknownPositions));
  });

  it('L2. all 7 canonical kinds followed by all unknowns', () => {
    const input = [
      layer('z-extra',     'e'),
      layer('instruction', 'ins'),
      layer('document',    'doc'),
      layer('quality',     'q'),
      layer('surface',     'sf'),
      layer('overview',    'ov'),
      layer('owner',       'ow'),
      layer('systemlaw',   'sl'),
    ];
    const result = kinds(orderLayers(input));
    expect(result).toEqual([
      'systemlaw', 'owner', 'overview', 'surface', 'quality', 'document', 'instruction',
      'z-extra',
    ]);
  });
});

// ---------------------------------------------------------------------------
// M. orderLayers — duplicate known kinds (stable order per-kind)
// ---------------------------------------------------------------------------

describe('M. orderLayers — duplicate known kinds', () => {
  it('M1. two systemlaw layers keep insertion order', () => {
    const input = [
      layer('systemlaw', 'global-rules'),
      layer('owner',     'persona'),
      layer('systemlaw', 'extra-rules'),
    ];
    const result = orderLayers(input);
    expect(result[0].content).toBe('global-rules');
    expect(result[1].content).toBe('extra-rules');
    expect(result[2].content).toBe('persona');
  });

  it('M2. all-duplicate-kind array keeps original order', () => {
    const input = [
      layer('surface', 's1'),
      layer('surface', 's2'),
      layer('surface', 's3'),
    ];
    const result = orderLayers(input);
    expect(result.map((l) => l.content)).toEqual(['s1', 's2', 's3']);
  });
});

// ---------------------------------------------------------------------------
// N. orderLayers — multiple unknowns preserve relative order
// ---------------------------------------------------------------------------

describe('N. orderLayers — multiple unknowns preserve relative order', () => {
  it('N1. four unknown kinds maintain insertion order among themselves', () => {
    const input = [
      layer('d-kind', '4'),
      layer('a-kind', '1'),
      layer('c-kind', '3'),
      layer('b-kind', '2'),
    ];
    const result = orderLayers(input);
    expect(result.map((l) => l.content)).toEqual(['4', '1', '3', '2']);
  });

  it('N2. known kind among unknowns sorts before all unknowns', () => {
    const input = [
      layer('zzz',       'unknown-1'),
      layer('owner',     'owner-content'),
      layer('aaa',       'unknown-2'),
    ];
    const result = orderLayers(input);
    expect(result[0].kind).toBe('owner');
    expect(result[1].content).toBe('unknown-1');
    expect(result[2].content).toBe('unknown-2');
  });
});

// ---------------------------------------------------------------------------
// O. LAYER_KINDS export — schema integrity
// ---------------------------------------------------------------------------

describe('O. LAYER_KINDS export — schema integrity', () => {
  it('O1. LAYER_KINDS has exactly 7 entries', () => {
    expect(LAYER_KINDS).toHaveLength(7);
  });

  it('O2. LAYER_KINDS is in canonical position order', () => {
    const positions = (LAYER_KINDS as readonly string[]).map(layerPosition);
    for (let i = 0; i < positions.length - 1; i++) {
      expect(positions[i]).toBeLessThan(positions[i + 1]);
    }
  });

  it('O3. systemlaw is at index 0', () => {
    expect(LAYER_KINDS[0]).toBe('systemlaw');
  });

  it('O4. instruction is at index 6 (last)', () => {
    expect(LAYER_KINDS[6]).toBe('instruction');
  });

  it('O5. all expected kind strings are present', () => {
    const expected = ['systemlaw', 'owner', 'overview', 'surface', 'quality', 'document', 'instruction'];
    for (const k of expected) {
      expect(LAYER_KINDS).toContain(k);
    }
  });
});

// ---------------------------------------------------------------------------
// P. LAYER_KINDS — exact spec-documented sequence (Sub-AC 8.1)
//
// These tests are the normative assertion for Sub-AC 8.1:
//   "The layer-ordering primitive has a unit test asserting all 7 layer
//    identifiers are emitted in the exact spec-documented sequence when
//    iterated or sorted."
//
// The spec-documented sequence (from order.ts header comment):
//   Position 0 — systemlaw
//   Position 1 — owner
//   Position 2 — overview
//   Position 3 — surface
//   Position 4 — quality
//   Position 5 — document
//   Position 6 — instruction
// ---------------------------------------------------------------------------

/** The canonical 7-layer sequence as documented in the spec. */
const SPEC_SEQUENCE = [
  'systemlaw',
  'owner',
  'overview',
  'surface',
  'quality',
  'document',
  'instruction',
] as const;

describe('P. LAYER_KINDS — exact spec-documented sequence (Sub-AC 8.1)', () => {
  it('P1. iterating LAYER_KINDS produces exactly the spec sequence', () => {
    // Direct index-by-index iteration must yield the spec order.
    expect([...LAYER_KINDS]).toEqual([...SPEC_SEQUENCE]);
  });

  it('P2. each LAYER_KINDS entry at index n matches SPEC_SEQUENCE[n]', () => {
    // Belt-and-suspenders: per-slot equality so a failure identifies which slot.
    SPEC_SEQUENCE.forEach((expectedKind, idx) => {
      expect(LAYER_KINDS[idx]).toBe(expectedKind);
    });
  });

  it('P3. sorting one PromptLayer per kind by layerPosition reproduces the spec sequence', () => {
    // Build one layer per kind, deliberately shuffled.
    const shuffled: PromptLayer[] = [
      layer('overview',    'ov'),
      layer('quality',     'q'),
      layer('systemlaw',   'sl'),
      layer('instruction', 'ins'),
      layer('surface',     'sf'),
      layer('document',    'doc'),
      layer('owner',       'ow'),
    ];
    const sorted = orderLayers(shuffled);
    expect(sorted.map((l) => l.kind)).toEqual([...SPEC_SEQUENCE]);
  });

  it('P4. layerPosition values for LAYER_KINDS match exactly [0,1,2,3,4,5,6]', () => {
    const positions = [...LAYER_KINDS].map(layerPosition);
    expect(positions).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it('P5. LAYER_KINDS spread to an array equals SPEC_SEQUENCE (no extra or missing entries)', () => {
    // This is the single most direct assertion required by Sub-AC 8.1.
    const iterated = Array.from(LAYER_KINDS);
    expect(iterated).toStrictEqual(Array.from(SPEC_SEQUENCE));
  });
});
