/**
 * resolve.test.ts
 *
 * Unit tests for `resolveLayersForSurface` (src/main/prompts/resolve.ts).
 *
 * Sub-AC 1.2 requirements:
 *   ✓ Correct layer set (systemlaw, owner, overview) returned for each of the
 *     four AI surfaces (BlockAI, SideChat, BottomChat, QualityDial)
 *   ✓ Returned layers are in canonical 7-layer order (positions 0, 1, 2)
 *   ✓ overview layer carries isStub: true (Phase 2 marker)
 *   ✓ systemlaw and owner layers carry sourcePath and optional metadata
 *   ✓ Unknown surface identifier throws RangeError (fail-fast, no silent garbage)
 *   ✓ Each call returns a NEW array (no shared state between calls)
 *   ✓ Layer objects are independent (mutation of one call's result does not
 *     affect a subsequent call's result)
 *   ✓ Content is always '' for all layers (stubs — never pre-filled)
 *   ✓ Returned layers are compatible with orderLayers() from order.ts
 *   ✓ VALID_SURFACES export covers exactly the four expected identifiers
 *
 * Test groups:
 *   A. VALID_SURFACES export — all four surfaces present
 *   B. BlockAI — correct layer set
 *   C. SideChat — correct layer set
 *   D. BottomChat — correct layer set
 *   E. QualityDial — correct layer set
 *   F. Layer ordering — returned in canonical 7-layer order
 *   G. Overview stub — isStub flag and empty content
 *   H. systemlaw layer metadata
 *   I. owner layer metadata
 *   J. RangeError for unknown surfaces
 *   K. Purity — new array per call, no shared mutation
 *   L. Compatibility with orderLayers()
 *   M. Cross-surface consistency — all surfaces return equivalent structure
 */

import { describe, it, expect } from 'vitest';
import {
  resolveLayersForSurface,
  VALID_SURFACES,
  type AISurface,
  type SurfaceLayer,
} from '../../src/main/prompts/resolve';
import { orderLayers, layerPosition, type PromptLayer } from '../../src/main/prompts/order';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract just the `kind` strings from an array of layers. */
function kinds(layers: SurfaceLayer[]): string[] {
  return layers.map((l) => l.kind);
}

/** The four valid surface identifiers in definition order. */
const ALL_SURFACES: AISurface[] = ['BlockAI', 'SideChat', 'BottomChat', 'QualityDial'];

/** The three expected global layer kinds in canonical order. */
const EXPECTED_KINDS = ['systemlaw', 'owner', 'overview'] as const;

// ---------------------------------------------------------------------------
// A. VALID_SURFACES export
// ---------------------------------------------------------------------------

describe('A. VALID_SURFACES export', () => {
  it('A1. VALID_SURFACES is a Set', () => {
    expect(VALID_SURFACES).toBeInstanceOf(Set);
  });

  it('A2. VALID_SURFACES has exactly 4 members', () => {
    expect(VALID_SURFACES.size).toBe(4);
  });

  it('A3. BlockAI is a valid surface', () => {
    expect(VALID_SURFACES.has('BlockAI')).toBe(true);
  });

  it('A4. SideChat is a valid surface', () => {
    expect(VALID_SURFACES.has('SideChat')).toBe(true);
  });

  it('A5. BottomChat is a valid surface', () => {
    expect(VALID_SURFACES.has('BottomChat')).toBe(true);
  });

  it('A6. QualityDial is a valid surface', () => {
    expect(VALID_SURFACES.has('QualityDial')).toBe(true);
  });

  it('A7. Lowercase variants are NOT valid (case-sensitive)', () => {
    expect(VALID_SURFACES.has('blockAI' as AISurface)).toBe(false);
    expect(VALID_SURFACES.has('sidechat' as AISurface)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// B. BlockAI — correct layer set
// ---------------------------------------------------------------------------

describe('B. BlockAI — correct layer set', () => {
  const layers = resolveLayersForSurface('BlockAI');

  it('B1. returns exactly 3 layers', () => {
    expect(layers).toHaveLength(3);
  });

  it('B2. first layer kind is systemlaw', () => {
    expect(layers[0].kind).toBe('systemlaw');
  });

  it('B3. second layer kind is owner', () => {
    expect(layers[1].kind).toBe('owner');
  });

  it('B4. third layer kind is overview', () => {
    expect(layers[2].kind).toBe('overview');
  });

  it('B5. layer kinds are exactly [systemlaw, owner, overview]', () => {
    expect(kinds(layers)).toEqual(['systemlaw', 'owner', 'overview']);
  });

  it('B6. all layer contents are empty string', () => {
    for (const layer of layers) {
      expect(layer.content).toBe('');
    }
  });
});

// ---------------------------------------------------------------------------
// C. SideChat — correct layer set
// ---------------------------------------------------------------------------

describe('C. SideChat — correct layer set', () => {
  const layers = resolveLayersForSurface('SideChat');

  it('C1. returns exactly 3 layers', () => {
    expect(layers).toHaveLength(3);
  });

  it('C2. layer kinds are [systemlaw, owner, overview]', () => {
    expect(kinds(layers)).toEqual(['systemlaw', 'owner', 'overview']);
  });

  it('C3. all layer contents are empty string', () => {
    for (const layer of layers) {
      expect(layer.content).toBe('');
    }
  });

  it('C4. systemlaw layer has sourcePath', () => {
    const sl = layers.find((l) => l.kind === 'systemlaw')!;
    expect(sl.sourcePath).toBeTruthy();
  });

  it('C5. owner layer has sourcePath', () => {
    const ow = layers.find((l) => l.kind === 'owner')!;
    expect(ow.sourcePath).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// D. BottomChat — correct layer set
// ---------------------------------------------------------------------------

describe('D. BottomChat — correct layer set', () => {
  const layers = resolveLayersForSurface('BottomChat');

  it('D1. returns exactly 3 layers', () => {
    expect(layers).toHaveLength(3);
  });

  it('D2. layer kinds are [systemlaw, owner, overview]', () => {
    expect(kinds(layers)).toEqual(['systemlaw', 'owner', 'overview']);
  });

  it('D3. all layer contents are empty string', () => {
    for (const layer of layers) {
      expect(layer.content).toBe('');
    }
  });

  it('D4. overview layer is marked as stub', () => {
    const ov = layers.find((l) => l.kind === 'overview')!;
    expect(ov.isStub).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// E. QualityDial — correct layer set
// ---------------------------------------------------------------------------

describe('E. QualityDial — correct layer set', () => {
  const layers = resolveLayersForSurface('QualityDial');

  it('E1. returns exactly 3 layers', () => {
    expect(layers).toHaveLength(3);
  });

  it('E2. layer kinds are [systemlaw, owner, overview]', () => {
    expect(kinds(layers)).toEqual(['systemlaw', 'owner', 'overview']);
  });

  it('E3. all layer contents are empty string', () => {
    for (const layer of layers) {
      expect(layer.content).toBe('');
    }
  });

  it('E4. all layers are optional', () => {
    for (const layer of layers) {
      expect(layer.optional).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// F. Layer ordering — returned in canonical 7-layer order
// ---------------------------------------------------------------------------

describe('F. Layer ordering — canonical 7-layer positions', () => {
  for (const surface of ALL_SURFACES) {
    describe(`Surface: ${surface}`, () => {
      const layers = resolveLayersForSurface(surface);

      it(`${surface}: systemlaw is at canonical position 0`, () => {
        expect(layerPosition(layers[0].kind)).toBe(0);
      });

      it(`${surface}: owner is at canonical position 1`, () => {
        expect(layerPosition(layers[1].kind)).toBe(1);
      });

      it(`${surface}: overview is at canonical position 2`, () => {
        expect(layerPosition(layers[2].kind)).toBe(2);
      });

      it(`${surface}: positions are strictly increasing`, () => {
        const positions = layers.map((l) => layerPosition(l.kind));
        for (let i = 0; i < positions.length - 1; i++) {
          expect(positions[i]).toBeLessThan(positions[i + 1]);
        }
      });
    });
  }
});

// ---------------------------------------------------------------------------
// G. Overview stub — isStub flag and Phase 2 safety
// ---------------------------------------------------------------------------

describe('G. Overview stub — Phase 2 placeholder layer', () => {
  for (const surface of ALL_SURFACES) {
    it(`${surface}: overview layer has isStub: true`, () => {
      const layers = resolveLayersForSurface(surface);
      const ov = layers.find((l) => l.kind === 'overview')!;
      expect(ov).toBeDefined();
      expect(ov.isStub).toBe(true);
    });

    it(`${surface}: overview content is always ''`, () => {
      const layers = resolveLayersForSurface(surface);
      const ov = layers.find((l) => l.kind === 'overview')!;
      expect(ov.content).toBe('');
    });

    it(`${surface}: overview layer has no sourcePath (stub, not file-backed in Phase 1)`, () => {
      const layers = resolveLayersForSurface(surface);
      const ov = layers.find((l) => l.kind === 'overview')!;
      expect(ov.sourcePath).toBeUndefined();
    });

    it(`${surface}: overview layer is optional`, () => {
      const layers = resolveLayersForSurface(surface);
      const ov = layers.find((l) => l.kind === 'overview')!;
      expect(ov.optional).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// H. systemlaw layer metadata
// ---------------------------------------------------------------------------

describe('H. systemlaw layer metadata', () => {
  for (const surface of ALL_SURFACES) {
    it(`${surface}: systemlaw sourcePath is 'systemlaw.md'`, () => {
      const layers = resolveLayersForSurface(surface);
      const sl = layers.find((l) => l.kind === 'systemlaw')!;
      expect(sl.sourcePath).toBe('systemlaw.md');
    });

    it(`${surface}: systemlaw is optional (missing file must not crash)`, () => {
      const layers = resolveLayersForSurface(surface);
      const sl = layers.find((l) => l.kind === 'systemlaw')!;
      expect(sl.optional).toBe(true);
    });

    it(`${surface}: systemlaw content starts as ''`, () => {
      const layers = resolveLayersForSurface(surface);
      const sl = layers.find((l) => l.kind === 'systemlaw')!;
      expect(sl.content).toBe('');
    });

    it(`${surface}: systemlaw does NOT have isStub (it's a real file slot)`, () => {
      const layers = resolveLayersForSurface(surface);
      const sl = layers.find((l) => l.kind === 'systemlaw')!;
      expect(sl.isStub).toBeFalsy();
    });
  }
});

// ---------------------------------------------------------------------------
// I. owner layer metadata
// ---------------------------------------------------------------------------

describe('I. owner layer metadata', () => {
  for (const surface of ALL_SURFACES) {
    it(`${surface}: owner sourcePath is 'Owner.md'`, () => {
      const layers = resolveLayersForSurface(surface);
      const ow = layers.find((l) => l.kind === 'owner')!;
      expect(ow.sourcePath).toBe('Owner.md');
    });

    it(`${surface}: owner is optional (missing file must not crash)`, () => {
      const layers = resolveLayersForSurface(surface);
      const ow = layers.find((l) => l.kind === 'owner')!;
      expect(ow.optional).toBe(true);
    });

    it(`${surface}: owner content starts as ''`, () => {
      const layers = resolveLayersForSurface(surface);
      const ow = layers.find((l) => l.kind === 'owner')!;
      expect(ow.content).toBe('');
    });

    it(`${surface}: owner does NOT have isStub (it's a real file slot)`, () => {
      const layers = resolveLayersForSurface(surface);
      const ow = layers.find((l) => l.kind === 'owner')!;
      expect(ow.isStub).toBeFalsy();
    });
  }
});

// ---------------------------------------------------------------------------
// J. RangeError for unknown surfaces
// ---------------------------------------------------------------------------

describe('J. RangeError for unknown / invalid surfaces', () => {
  it('J1. empty string throws RangeError', () => {
    expect(() => resolveLayersForSurface('' as AISurface)).toThrow(RangeError);
  });

  it('J2. lowercase "blockai" throws RangeError', () => {
    expect(() => resolveLayersForSurface('blockai' as AISurface)).toThrow(RangeError);
  });

  it('J3. "block-ai" (kebab) throws RangeError', () => {
    expect(() => resolveLayersForSurface('block-ai' as AISurface)).toThrow(RangeError);
  });

  it('J4. "SIDECHAT" throws RangeError', () => {
    expect(() => resolveLayersForSurface('SIDECHAT' as AISurface)).toThrow(RangeError);
  });

  it('J5. "bottomchat" (no capital) throws RangeError', () => {
    expect(() => resolveLayersForSurface('bottomchat' as AISurface)).toThrow(RangeError);
  });

  it('J6. arbitrary string throws RangeError', () => {
    expect(() => resolveLayersForSurface('UnknownSurface' as AISurface)).toThrow(RangeError);
  });

  it('J7. error message names the invalid surface', () => {
    try {
      resolveLayersForSurface('BadSurface' as AISurface);
      expect.fail('should have thrown');
    } catch (err) {
      expect((err as Error).message).toContain('BadSurface');
    }
  });

  it('J8. error message lists valid surfaces', () => {
    try {
      resolveLayersForSurface('WrongSurface' as AISurface);
      expect.fail('should have thrown');
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain('BlockAI');
      expect(msg).toContain('SideChat');
      expect(msg).toContain('BottomChat');
      expect(msg).toContain('QualityDial');
    }
  });

  it('J9. numeric string throws RangeError', () => {
    expect(() => resolveLayersForSurface('0' as AISurface)).toThrow(RangeError);
  });

  it('J10. undefined-like string throws RangeError', () => {
    expect(() => resolveLayersForSurface('undefined' as AISurface)).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// K. Purity — new array per call, no shared mutation
// ---------------------------------------------------------------------------

describe('K. Purity — independent arrays across calls', () => {
  it('K1. two calls to the same surface return different array references', () => {
    const a = resolveLayersForSurface('BlockAI');
    const b = resolveLayersForSurface('BlockAI');
    expect(a).not.toBe(b);
  });

  it('K2. mutating the returned array does not affect the next call', () => {
    const first = resolveLayersForSurface('SideChat');
    first.push({ kind: 'injected', content: 'evil', optional: false });
    const second = resolveLayersForSurface('SideChat');
    expect(second).toHaveLength(3);
    expect(kinds(second)).toEqual(['systemlaw', 'owner', 'overview']);
  });

  it('K3. mutating a returned layer object does not affect the next call', () => {
    const first = resolveLayersForSurface('BottomChat');
    first[0].content = 'modified systemlaw content';
    const second = resolveLayersForSurface('BottomChat');
    expect(second[0].content).toBe('');
  });

  it('K4. calls for different surfaces return independent arrays', () => {
    const blockAI = resolveLayersForSurface('BlockAI');
    const sideChat = resolveLayersForSurface('SideChat');
    // Modify one
    blockAI[0].content = 'block-ai-modified';
    // Other is not affected
    expect(sideChat[0].content).toBe('');
  });

  it('K5. function is a total function for all four valid surfaces (no throws)', () => {
    for (const surface of ALL_SURFACES) {
      expect(() => resolveLayersForSurface(surface)).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// L. Compatibility with orderLayers()
// ---------------------------------------------------------------------------

describe('L. orderLayers() compatibility', () => {
  it('L1. BlockAI layers are already in canonical order after orderLayers()', () => {
    const layers = resolveLayersForSurface('BlockAI');
    const ordered = orderLayers(layers as PromptLayer[]);
    expect(kinds(ordered as SurfaceLayer[])).toEqual(['systemlaw', 'owner', 'overview']);
  });

  it('L2. SideChat layers stay in order after orderLayers()', () => {
    const layers = resolveLayersForSurface('SideChat');
    const ordered = orderLayers(layers as PromptLayer[]);
    expect(kinds(ordered as SurfaceLayer[])).toEqual(['systemlaw', 'owner', 'overview']);
  });

  it('L3. BottomChat layers stay in order after orderLayers()', () => {
    const layers = resolveLayersForSurface('BottomChat');
    const ordered = orderLayers(layers as PromptLayer[]);
    expect(kinds(ordered as SurfaceLayer[])).toEqual(['systemlaw', 'owner', 'overview']);
  });

  it('L4. QualityDial layers stay in order after orderLayers()', () => {
    const layers = resolveLayersForSurface('QualityDial');
    const ordered = orderLayers(layers as PromptLayer[]);
    expect(kinds(ordered as SurfaceLayer[])).toEqual(['systemlaw', 'owner', 'overview']);
  });

  it('L5. surface layers interleave correctly with surface/quality/instruction layers', () => {
    // Simulate what the caller does: mix global layers with surface-specific ones,
    // then call orderLayers to get canonical ordering.
    const globalLayers = resolveLayersForSurface('BottomChat') as PromptLayer[];
    const surfaceSpecific: PromptLayer[] = [
      { kind: 'surface',     content: 'bottom chat system prompt' },
      { kind: 'quality',     content: 'write at college level' },
      { kind: 'document',    content: '# My Document\n...' },
      { kind: 'instruction', content: 'rewrite as a list' },
    ];
    // Pass them in mixed order
    const mixed = [...surfaceSpecific, ...globalLayers];
    const ordered = orderLayers(mixed);
    expect(ordered.map((l) => l.kind)).toEqual([
      'systemlaw', 'owner', 'overview',
      'surface', 'quality', 'document', 'instruction',
    ]);
  });

  it('L6. metadata fields (optional, sourcePath, isStub) survive orderLayers()', () => {
    const layers = resolveLayersForSurface('BlockAI') as PromptLayer[];
    const ordered = orderLayers(layers) as SurfaceLayer[];

    const sl = ordered.find((l) => l.kind === 'systemlaw')!;
    expect(sl.optional).toBe(true);
    expect(sl.sourcePath).toBe('systemlaw.md');

    const ov = ordered.find((l) => l.kind === 'overview')!;
    expect(ov.isStub).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// M. Cross-surface consistency — all four surfaces return equivalent structure
// ---------------------------------------------------------------------------

describe('M. Cross-surface consistency', () => {
  it('M1. all four surfaces return 3 layers', () => {
    for (const surface of ALL_SURFACES) {
      expect(resolveLayersForSurface(surface)).toHaveLength(3);
    }
  });

  it('M2. all four surfaces return the same kind sequence', () => {
    const sequences = ALL_SURFACES.map((s) => kinds(resolveLayersForSurface(s)));
    for (const seq of sequences) {
      expect(seq).toEqual(['systemlaw', 'owner', 'overview']);
    }
  });

  it('M3. all four surfaces return empty content for all layers', () => {
    for (const surface of ALL_SURFACES) {
      const layers = resolveLayersForSurface(surface);
      for (const layer of layers) {
        expect(layer.content).toBe('');
      }
    }
  });

  it('M4. all four surfaces have optional: true for all layers', () => {
    for (const surface of ALL_SURFACES) {
      const layers = resolveLayersForSurface(surface);
      for (const layer of layers) {
        expect(layer.optional).toBe(true);
      }
    }
  });

  it('M5. all four surfaces mark overview as isStub: true', () => {
    for (const surface of ALL_SURFACES) {
      const layers = resolveLayersForSurface(surface);
      const ov = layers.find((l) => l.kind === 'overview')!;
      expect(ov.isStub).toBe(true);
    }
  });

  it('M6. systemlaw sourcePath is the same across all surfaces', () => {
    const paths = ALL_SURFACES.map((s) => {
      const layers = resolveLayersForSurface(s);
      return layers.find((l) => l.kind === 'systemlaw')!.sourcePath;
    });
    const unique = new Set(paths);
    expect(unique.size).toBe(1);
    expect([...unique][0]).toBe('systemlaw.md');
  });

  it('M7. owner sourcePath is the same across all surfaces', () => {
    const paths = ALL_SURFACES.map((s) => {
      const layers = resolveLayersForSurface(s);
      return layers.find((l) => l.kind === 'owner')!.sourcePath;
    });
    const unique = new Set(paths);
    expect(unique.size).toBe(1);
    expect([...unique][0]).toBe('Owner.md');
  });

  it('M8. resolving the same surface twice is idempotent in structure', () => {
    for (const surface of ALL_SURFACES) {
      const first = resolveLayersForSurface(surface);
      const second = resolveLayersForSurface(surface);
      expect(kinds(first)).toEqual(kinds(second));
      expect(first.map((l) => l.optional)).toEqual(second.map((l) => l.optional));
      expect(first.map((l) => l.sourcePath)).toEqual(second.map((l) => l.sourcePath));
    }
  });
});
