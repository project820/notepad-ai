/**
 * assemble.test.ts
 *
 * Unit tests for `assemblePrompt` (src/main/prompts/assemble.ts).
 *
 * Sub-AC 1.3 requirements:
 *   ✓ `assemblePrompt` composes `resolveLayersForSurface` and `orderLayers`
 *     to produce a final ordered context string.
 *   ✓ Returned string contains each expected layer's content in the correct
 *     sequence for at least two distinct surface types (BlockAI, SideChat).
 *   ✓ Uses injected / mocked layer content — no filesystem access.
 *   ✓ Empty or absent content layers are silently omitted from the output.
 *   ✓ Never crashes on partial or empty requests.
 *
 * Test groups:
 *   A. BlockAI surface — full 7-layer request
 *   B. SideChat surface — full 7-layer request
 *   C. BottomChat surface — full 7-layer request
 *   D. QualityDial surface — full 7-layer request
 *   E. Layer sequence order — content appears in canonical order
 *   F. Empty / missing layers are silently dropped
 *   G. Separator between layers is \n\n
 *   H. Edge cases — all-empty, single-layer, whitespace-only content
 *   I. Overview layer (Phase 1 stub) is always absent from output
 *   J. Returned string is AssembledPrompt type (string)
 *   K. Content is never trimmed, truncated, or modified
 *   L. Cross-surface: same content produces consistent results
 */

import { describe, it, expect } from 'vitest';
import { assemblePrompt, type AssemblyRequest, type AssembledPrompt } from '../../src/main/prompts/assemble';
import type { AISurface } from '../../src/main/prompts/resolve';

// ---------------------------------------------------------------------------
// Test fixtures — injected layer content
// ---------------------------------------------------------------------------

/** Fixed content strings for each layer so tests can assert ordering. */
const FIXTURES = {
  systemlaw:   '## Systemlaw\nBe concise. Respond in the same language as the user.',
  owner:       '## Owner\nName: Test User\nRole: Korean QA analyst',
  surface:     '## Surface\nYou are a professional editing assistant.',
  quality:     '## Quality\nWrite at a professional level.',
  document:    '## Document\n# My Report\nContent goes here.',
  instruction: '## Instruction\nRewrite this as a numbered list.',
} as const;

/** Build a full AssemblyRequest with all non-overview layers populated. */
function fullRequest(surface: AISurface): AssemblyRequest {
  return {
    surface,
    systemlawContent:  FIXTURES.systemlaw,
    ownerContent:      FIXTURES.owner,
    surfacePrompt:     FIXTURES.surface,
    qualityDirective:  FIXTURES.quality,
    documentText:      FIXTURES.document,
    userInstruction:   FIXTURES.instruction,
  };
}

/**
 * Return the index at which `substring` first appears in `str`.
 * Returns -1 if not found (mirrors String#indexOf).
 */
function indexOf(str: string, substring: string): number {
  return str.indexOf(substring);
}

/**
 * Assert that `earlier` appears before `later` in `text`.
 * Both strings must be present; earlier index < later index.
 */
function assertOrder(text: string, earlier: string, later: string): void {
  const idxA = indexOf(text, earlier);
  const idxB = indexOf(text, later);
  expect(idxA).toBeGreaterThanOrEqual(0);
  expect(idxB).toBeGreaterThanOrEqual(0);
  expect(idxA).toBeLessThan(idxB);
}

// ---------------------------------------------------------------------------
// A. BlockAI surface — full 7-layer request
// ---------------------------------------------------------------------------

describe('A. BlockAI — full 7-layer request', () => {
  const result = assemblePrompt(fullRequest('BlockAI'));

  it('A1. returns a non-empty string', () => {
    expect(result.length).toBeGreaterThan(0);
  });

  it('A2. contains systemlaw content', () => {
    expect(result).toContain(FIXTURES.systemlaw);
  });

  it('A3. contains owner content', () => {
    expect(result).toContain(FIXTURES.owner);
  });

  it('A4. does NOT contain overview content (Phase 1 stub — always empty)', () => {
    // The overview layer is always '' in Phase 1 — should not contribute text.
    // We verify no "overview" heading leaked into the output.
    // (The stub layer has no content, so nothing is emitted.)
    expect(result).not.toContain('OVERVIEW_PLACEHOLDER');
  });

  it('A5. contains surface prompt content', () => {
    expect(result).toContain(FIXTURES.surface);
  });

  it('A6. contains quality directive content', () => {
    expect(result).toContain(FIXTURES.quality);
  });

  it('A7. contains document text content', () => {
    expect(result).toContain(FIXTURES.document);
  });

  it('A8. contains user instruction content', () => {
    expect(result).toContain(FIXTURES.instruction);
  });

  it('A9. layers appear in canonical order: systemlaw before owner', () => {
    assertOrder(result, FIXTURES.systemlaw, FIXTURES.owner);
  });

  it('A10. layers appear in canonical order: owner before surface', () => {
    assertOrder(result, FIXTURES.owner, FIXTURES.surface);
  });

  it('A11. layers appear in canonical order: surface before quality', () => {
    assertOrder(result, FIXTURES.surface, FIXTURES.quality);
  });

  it('A12. layers appear in canonical order: quality before document', () => {
    assertOrder(result, FIXTURES.quality, FIXTURES.document);
  });

  it('A13. layers appear in canonical order: document before instruction', () => {
    assertOrder(result, FIXTURES.document, FIXTURES.instruction);
  });

  it('A14. full canonical chain: systemlaw → owner → surface → quality → document → instruction', () => {
    assertOrder(result, FIXTURES.systemlaw, FIXTURES.owner);
    assertOrder(result, FIXTURES.owner,     FIXTURES.surface);
    assertOrder(result, FIXTURES.surface,   FIXTURES.quality);
    assertOrder(result, FIXTURES.quality,   FIXTURES.document);
    assertOrder(result, FIXTURES.document,  FIXTURES.instruction);
  });
});

// ---------------------------------------------------------------------------
// B. SideChat surface — full 7-layer request
// ---------------------------------------------------------------------------

describe('B. SideChat — full 7-layer request', () => {
  const result = assemblePrompt(fullRequest('SideChat'));

  it('B1. returns a non-empty string', () => {
    expect(result.length).toBeGreaterThan(0);
  });

  it('B2. contains systemlaw content', () => {
    expect(result).toContain(FIXTURES.systemlaw);
  });

  it('B3. contains owner content', () => {
    expect(result).toContain(FIXTURES.owner);
  });

  it('B4. contains surface prompt content', () => {
    expect(result).toContain(FIXTURES.surface);
  });

  it('B5. contains quality directive content', () => {
    expect(result).toContain(FIXTURES.quality);
  });

  it('B6. contains document text content', () => {
    expect(result).toContain(FIXTURES.document);
  });

  it('B7. contains user instruction content', () => {
    expect(result).toContain(FIXTURES.instruction);
  });

  it('B8. full canonical chain: systemlaw → owner → surface → quality → document → instruction', () => {
    assertOrder(result, FIXTURES.systemlaw, FIXTURES.owner);
    assertOrder(result, FIXTURES.owner,     FIXTURES.surface);
    assertOrder(result, FIXTURES.surface,   FIXTURES.quality);
    assertOrder(result, FIXTURES.quality,   FIXTURES.document);
    assertOrder(result, FIXTURES.document,  FIXTURES.instruction);
  });

  it('B9. SideChat result is identical to BlockAI result for the same content (surface ID does not alter assembly in Phase 1)', () => {
    const blockAIResult = assemblePrompt(fullRequest('BlockAI'));
    expect(result).toBe(blockAIResult);
  });
});

// ---------------------------------------------------------------------------
// C. BottomChat surface — full 7-layer request
// ---------------------------------------------------------------------------

describe('C. BottomChat — full 7-layer request', () => {
  const result = assemblePrompt(fullRequest('BottomChat'));

  it('C1. returns a non-empty string', () => {
    expect(result.length).toBeGreaterThan(0);
  });

  it('C2. all 6 non-overview layers are present', () => {
    expect(result).toContain(FIXTURES.systemlaw);
    expect(result).toContain(FIXTURES.owner);
    expect(result).toContain(FIXTURES.surface);
    expect(result).toContain(FIXTURES.quality);
    expect(result).toContain(FIXTURES.document);
    expect(result).toContain(FIXTURES.instruction);
  });

  it('C3. canonical ordering preserved', () => {
    assertOrder(result, FIXTURES.systemlaw, FIXTURES.instruction);
    assertOrder(result, FIXTURES.owner, FIXTURES.document);
  });
});

// ---------------------------------------------------------------------------
// D. QualityDial surface — full 7-layer request
// ---------------------------------------------------------------------------

describe('D. QualityDial — full 7-layer request', () => {
  const result = assemblePrompt(fullRequest('QualityDial'));

  it('D1. returns a non-empty string', () => {
    expect(result.length).toBeGreaterThan(0);
  });

  it('D2. all 6 non-overview layers are present', () => {
    expect(result).toContain(FIXTURES.systemlaw);
    expect(result).toContain(FIXTURES.owner);
    expect(result).toContain(FIXTURES.surface);
    expect(result).toContain(FIXTURES.quality);
    expect(result).toContain(FIXTURES.document);
    expect(result).toContain(FIXTURES.instruction);
  });

  it('D3. canonical ordering preserved', () => {
    assertOrder(result, FIXTURES.systemlaw, FIXTURES.quality);
    assertOrder(result, FIXTURES.quality, FIXTURES.instruction);
  });
});

// ---------------------------------------------------------------------------
// E. Layer sequence order — content appears in strict canonical order
// ---------------------------------------------------------------------------

describe('E. Layer sequence order — canonical positions', () => {
  it('E1. systemlaw is at the earliest position among all present layers', () => {
    const result = assemblePrompt(fullRequest('BlockAI'));
    const slPos = result.indexOf(FIXTURES.systemlaw);
    expect(slPos).toBe(0);  // systemlaw starts the assembled string
  });

  it('E2. instruction is the last layer in the output', () => {
    const result = assemblePrompt(fullRequest('BlockAI'));
    const insPos  = result.lastIndexOf(FIXTURES.instruction);
    const insEnd  = insPos + FIXTURES.instruction.length;
    // After trimming trailing whitespace, instruction should be at the end
    expect(result.trimEnd().endsWith(FIXTURES.instruction.trimEnd())).toBe(true);
  });

  it('E3. partial request: only systemlaw and instruction — systemlaw comes first', () => {
    const result = assemblePrompt({
      surface: 'BlockAI',
      systemlawContent: 'SL-CONTENT',
      userInstruction:  'INS-CONTENT',
    });
    assertOrder(result, 'SL-CONTENT', 'INS-CONTENT');
  });

  it('E4. partial request: only owner and quality — owner before quality', () => {
    const result = assemblePrompt({
      surface:          'SideChat',
      ownerContent:     'OW-CONTENT',
      qualityDirective: 'QD-CONTENT',
    });
    assertOrder(result, 'OW-CONTENT', 'QD-CONTENT');
  });

  it('E5. partial request: quality and systemlaw in reverse — still systemlaw first', () => {
    // Even if caller passes only qualityDirective and systemlawContent,
    // orderLayers ensures systemlaw (pos 0) precedes quality (pos 4).
    const result = assemblePrompt({
      surface:          'BottomChat',
      qualityDirective: 'QUALITY-FIRST-ATTEMPT',
      systemlawContent: 'SYSTEMLAW-SHOULD-WIN',
    });
    assertOrder(result, 'SYSTEMLAW-SHOULD-WIN', 'QUALITY-FIRST-ATTEMPT');
  });

  it('E6. full ordering: each pair is correctly ordered for all 7 positions', () => {
    const result = assemblePrompt(fullRequest('BlockAI'));
    const order = [
      FIXTURES.systemlaw,
      FIXTURES.owner,
      // overview omitted (empty stub)
      FIXTURES.surface,
      FIXTURES.quality,
      FIXTURES.document,
      FIXTURES.instruction,
    ];
    for (let i = 0; i < order.length - 1; i++) {
      assertOrder(result, order[i], order[i + 1]);
    }
  });
});

// ---------------------------------------------------------------------------
// F. Empty / missing layers are silently dropped
// ---------------------------------------------------------------------------

describe('F. Empty / missing layers are silently dropped', () => {
  it('F1. missing systemlawContent → systemlaw text absent from output', () => {
    const result = assemblePrompt({
      surface:        'BlockAI',
      surfacePrompt:  'Surface only',
      userInstruction: 'Do this',
    });
    // There's no systemlaw content — it must not appear
    // (We check the fixture text is absent)
    expect(result).not.toContain(FIXTURES.systemlaw);
  });

  it('F2. empty string systemlawContent → omitted from output', () => {
    const result = assemblePrompt({
      surface:          'BlockAI',
      systemlawContent: '',
      surfacePrompt:    'Surface prompt',
      userInstruction:  'Do this',
    });
    expect(result).toContain('Surface prompt');
    expect(result).toContain('Do this');
    // Empty systemlaw does not add empty lines or placeholders
    expect(result.startsWith('Surface prompt')).toBe(true);
  });

  it('F3. whitespace-only content → omitted from output', () => {
    const result = assemblePrompt({
      surface:          'SideChat',
      systemlawContent: '   \n\n  ',
      ownerContent:     '\t',
      surfacePrompt:    'Real surface prompt',
      userInstruction:  'Real instruction',
    });
    expect(result).toContain('Real surface prompt');
    expect(result).toContain('Real instruction');
    // Whitespace-only layers should not appear between the real content
    expect(result.trim()).toBe('Real surface prompt\n\nReal instruction');
  });

  it('F4. overview layer is always absent (Phase 1 stub)', () => {
    // The overview layer content is always '' inside assemblePrompt —
    // no caller-supplied field can set it.  Verify it emits nothing.
    const result = assemblePrompt({
      surface:          'BottomChat',
      systemlawContent: 'SL',
      userInstruction:  'INS',
    });
    // overview slot contributes no text — only SL and INS are present.
    expect(result).toBe('SL\n\nINS');
  });

  it('F5. omitting all optional fields → only userInstruction in output', () => {
    const result = assemblePrompt({
      surface:         'QualityDial',
      userInstruction: 'Only this',
    });
    expect(result).toBe('Only this');
  });

  it('F6. omitting qualityDirective → quality text absent', () => {
    const result = assemblePrompt({
      surface:          'BlockAI',
      systemlawContent: 'SL',
      userInstruction:  'INS',
    });
    expect(result).not.toContain(FIXTURES.quality);
    expect(result).toBe('SL\n\nINS');
  });

  it('F7. omitting documentText → document text absent', () => {
    const result = assemblePrompt({
      surface:         'SideChat',
      surfacePrompt:   'SP',
      userInstruction: 'INS',
    });
    expect(result).not.toContain(FIXTURES.document);
  });
});

// ---------------------------------------------------------------------------
// G. Separator between layers is \n\n
// ---------------------------------------------------------------------------

describe('G. Layer separator is \\n\\n', () => {
  it('G1. two-layer output has exactly one \\n\\n between them', () => {
    const result = assemblePrompt({
      surface:          'BlockAI',
      systemlawContent: 'LAYER-A',
      userInstruction:  'LAYER-B',
    });
    expect(result).toBe('LAYER-A\n\nLAYER-B');
  });

  it('G2. three-layer output has \\n\\n between each adjacent pair', () => {
    const result = assemblePrompt({
      surface:          'BlockAI',
      systemlawContent: 'LAYER-A',
      ownerContent:     'LAYER-B',
      userInstruction:  'LAYER-C',
    });
    expect(result).toBe('LAYER-A\n\nLAYER-B\n\nLAYER-C');
  });

  it('G3. no trailing \\n\\n after the last layer', () => {
    const result = assemblePrompt({
      surface:         'SideChat',
      surfacePrompt:   'SP',
      userInstruction: 'INS',
    });
    expect(result.endsWith('\n\n')).toBe(false);
    expect(result).toBe('SP\n\nINS');
  });

  it('G4. no leading \\n\\n before the first layer', () => {
    const result = assemblePrompt({
      surface:          'BottomChat',
      systemlawContent: 'FIRST',
      userInstruction:  'LAST',
    });
    expect(result.startsWith('\n\n')).toBe(false);
    expect(result).toBe('FIRST\n\nLAST');
  });

  it('G5. single-layer output has no separator at all', () => {
    const result = assemblePrompt({
      surface:         'BlockAI',
      userInstruction: 'ONLY-LAYER',
    });
    expect(result).toBe('ONLY-LAYER');
    expect(result).not.toContain('\n\n');
  });

  it('G6. six-layer output (no overview) has five \\n\\n separators', () => {
    const result = assemblePrompt(fullRequest('BlockAI'));
    // Count non-overlapping occurrences of '\n\n'
    const matches = result.match(/\n\n/g);
    expect(matches).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------
// H. Edge cases — all-empty, undefined fields, whitespace variants
// ---------------------------------------------------------------------------

describe('H. Edge cases', () => {
  it('H1. empty request (all fields absent) → empty string', () => {
    const result = assemblePrompt({ surface: 'BlockAI' });
    expect(result).toBe('');
  });

  it('H2. all fields explicitly empty string → empty string', () => {
    const result = assemblePrompt({
      surface:          'SideChat',
      systemlawContent: '',
      ownerContent:     '',
      surfacePrompt:    '',
      qualityDirective: '',
      documentText:     '',
      userInstruction:  '',
    });
    expect(result).toBe('');
  });

  it('H3. single non-empty layer → that layer content verbatim', () => {
    const result = assemblePrompt({
      surface:      'BlockAI',
      surfacePrompt: 'Hello world',
    });
    expect(result).toBe('Hello world');
  });

  it('H4. assemblePrompt never throws regardless of input combination', () => {
    const combinations: AssemblyRequest[] = [
      { surface: 'BlockAI' },
      { surface: 'SideChat',   systemlawContent: '' },
      { surface: 'BottomChat', ownerContent: undefined },
      { surface: 'QualityDial', qualityDirective: '   ' },
      { surface: 'BlockAI',    userInstruction: '\n\n\n' },
    ];
    for (const req of combinations) {
      expect(() => assemblePrompt(req)).not.toThrow();
    }
  });

  it('H5. multiline content within a single layer is preserved verbatim', () => {
    const multiline = '# Title\n\nParagraph one.\n\nParagraph two.';
    const result = assemblePrompt({
      surface:         'BlockAI',
      surfacePrompt:   multiline,
      userInstruction: 'Edit this',
    });
    // The double-newline inside the layer content is preserved
    expect(result).toContain(multiline);
    // The separator between layers is also \n\n — so the output contains
    // the layer content followed by \n\n then the instruction
    expect(result).toBe(`${multiline}\n\nEdit this`);
  });

  it('H6. content with leading/trailing whitespace is NOT trimmed by assemblePrompt', () => {
    // The filter only drops layers where the TRIMMED content is empty;
    // the original (un-trimmed) content is emitted as-is.
    const spacedContent = '  leading and trailing  ';
    const result = assemblePrompt({
      surface:      'SideChat',
      surfacePrompt: spacedContent,
    });
    expect(result).toBe(spacedContent);
  });

  it('H7. assemblePrompt is a pure function — same input always yields same output', () => {
    const req = fullRequest('BlockAI');
    expect(assemblePrompt(req)).toBe(assemblePrompt(req));
  });

  it('H8. calling assemblePrompt twice does not mutate the request', () => {
    const req = fullRequest('SideChat');
    const snapshot = { ...req };
    assemblePrompt(req);
    assemblePrompt(req);
    expect(req).toEqual(snapshot);
  });
});

// ---------------------------------------------------------------------------
// I. Overview layer (Phase 1 stub) is always absent from output
// ---------------------------------------------------------------------------

describe('I. Overview layer — Phase 1 stub always absent', () => {
  it('I1. overview is never in the output even when all other layers are populated', () => {
    const result = assemblePrompt(fullRequest('BlockAI'));
    // We can't directly check "overview content absent" since overview content
    // is '' — but we can verify the count of layers is 6 (not 7).
    // Count separators: 6 layers → 5 separators.
    const separatorCount = (result.match(/\n\n/g) ?? []).length;
    expect(separatorCount).toBe(5);
  });

  it('I2. overview slot contributes no empty lines between surrounding layers', () => {
    // With systemlaw, owner, surface in that order and overview '' in between,
    // the output should be systemlaw \n\n owner \n\n surface (no triple \n).
    const result = assemblePrompt({
      surface:          'BottomChat',
      systemlawContent: 'SL',
      ownerContent:     'OW',
      surfacePrompt:    'SP',
    });
    expect(result).toBe('SL\n\nOW\n\nSP');
    // No triple newline from the empty overview slot
    expect(result).not.toContain('\n\n\n');
  });

  it('I3. overview has no way to be populated from AssemblyRequest fields', () => {
    // AssemblyRequest has no `overviewContent` field — this is by design.
    // The TypeScript type ensures callers cannot accidentally set it.
    const req: AssemblyRequest = fullRequest('SideChat');
    expect('overviewContent' in req).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// J. Returned type is AssembledPrompt (a string)
// ---------------------------------------------------------------------------

describe('J. AssembledPrompt return type', () => {
  it('J1. return value is a string', () => {
    const result = assemblePrompt(fullRequest('BlockAI'));
    expect(typeof result).toBe('string');
  });

  it('J2. empty result is still a string (not null/undefined)', () => {
    const result = assemblePrompt({ surface: 'BlockAI' });
    expect(typeof result).toBe('string');
    expect(result).toBe('');
  });

  it('J3. AssembledPrompt is assignable to string', () => {
    const result: AssembledPrompt = assemblePrompt({ surface: 'SideChat' });
    const s: string = result;
    expect(typeof s).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// K. Content is never trimmed, truncated, or modified
// ---------------------------------------------------------------------------

describe('K. Content fidelity — no trimming or modification', () => {
  it('K1. systemlaw content is emitted verbatim', () => {
    const raw = '  ## Rules\n- Rule 1\n- Rule 2  ';
    const result = assemblePrompt({
      surface:          'BlockAI',
      systemlawContent: raw,
    });
    expect(result).toBe(raw);
  });

  it('K2. owner content is emitted verbatim', () => {
    const raw = 'Name: 김동인\nRole: 분석가\n\nContext: 한국어로 응답하세요.';
    const result = assemblePrompt({
      surface:      'SideChat',
      ownerContent: raw,
    });
    expect(result).toBe(raw);
  });

  it('K3. multi-paragraph instruction is emitted verbatim', () => {
    const raw = 'Step 1: Do this.\n\nStep 2: Do that.\n\nStep 3: Done.';
    const result = assemblePrompt({
      surface:         'BottomChat',
      userInstruction: raw,
    });
    expect(result).toBe(raw);
  });

  it('K4. Unicode and Korean content is preserved', () => {
    const korean = '이 문서를 전문적인 한국어로 다시 작성하세요.';
    const result = assemblePrompt({
      surface:         'BlockAI',
      userInstruction: korean,
    });
    expect(result).toBe(korean);
  });

  it('K5. content with Markdown code fences is preserved', () => {
    const code = '```typescript\nconst x = 1;\n```';
    const result = assemblePrompt({
      surface:      'SideChat',
      documentText: code,
    });
    expect(result).toBe(code);
  });
});

// ---------------------------------------------------------------------------
// L. Cross-surface: same content → same output for all surfaces
// ---------------------------------------------------------------------------

describe('L. Cross-surface consistency', () => {
  it('L1. all four surfaces produce the same output for identical content', () => {
    const surfaces: AISurface[] = ['BlockAI', 'SideChat', 'BottomChat', 'QualityDial'];
    const results = surfaces.map((surface) => assemblePrompt(fullRequest(surface)));
    // All should be equal
    for (let i = 1; i < results.length; i++) {
      expect(results[i]).toBe(results[0]);
    }
  });

  it('L2. surface-specific differences only come from surfacePrompt content', () => {
    const blockAI = assemblePrompt({
      surface:          'BlockAI',
      systemlawContent: 'GLOBAL',
      surfacePrompt:    'BLOCK-AI-SURFACE',
      userInstruction:  'INST',
    });
    const sideChat = assemblePrompt({
      surface:          'SideChat',
      systemlawContent: 'GLOBAL',
      surfacePrompt:    'SIDE-CHAT-SURFACE',
      userInstruction:  'INST',
    });
    // Different surface prompts → different output
    expect(blockAI).not.toBe(sideChat);
    expect(blockAI).toContain('BLOCK-AI-SURFACE');
    expect(sideChat).toContain('SIDE-CHAT-SURFACE');
    // Both share the same global and instruction
    expect(blockAI).toContain('GLOBAL');
    expect(sideChat).toContain('GLOBAL');
    expect(blockAI).toContain('INST');
    expect(sideChat).toContain('INST');
  });

  it('L3. surface identifier is not embedded in the assembled string', () => {
    for (const surface of ['BlockAI', 'SideChat', 'BottomChat', 'QualityDial'] as AISurface[]) {
      const result = assemblePrompt({
        surface,
        userInstruction: 'Hello',
      });
      // The surface name itself should not appear in the output
      expect(result).not.toContain(surface);
    }
  });
});
