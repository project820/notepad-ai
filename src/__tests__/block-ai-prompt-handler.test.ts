/**
 * block-ai-prompt-handler.test.ts
 *
 * Unit tests for `buildBlockAiInstructions(req, assemble?)`.
 *
 * Sub-AC 3.2 requirements:
 *   ✓ Toggle-off branch → uses legacy v1.0 path; assembler NOT called
 *   ✓ Toggle-on branch  → delegates to the assembler; mock IS called
 *   ✓ Assembler receives a correct AssemblyRequest when toggle is on
 *   ✓ Legacy path output matches v1.0 concatenation exactly
 *   ✓ Cross-branch isolation — toggle-on never uses legacy concat
 *   ✓ Edge cases: empty fields, undefined fields, whitespace-only quality
 *
 * Strategy:
 *   The `assemble` parameter is injected as a `vi.fn()` so each branch
 *   can be exercised independently without coupling to the real `assemblePrompt`
 *   implementation.  The real implementation is unit-tested separately in
 *   assemble.test.ts.
 *
 * Test groups:
 *   A. Toggle-off path   — legacy v1.0 string returned; assembler not called
 *   B. Toggle-on path    — assembler called; its return value forwarded
 *   C. Assembler args    — correct AssemblyRequest built for toggle-on
 *   D. Legacy string     — exact legacy concatenation for toggle-off
 *   E. Cross-branch      — toggle-on never uses legacy concat; vice-versa
 *   F. Edge cases        — empty / undefined / whitespace fields
 *   G. Default assembler — called when no second arg provided (smoke test)
 *   H. Type conformance  — AssemblerFn and BlockAiPromptRequest types
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  buildBlockAiInstructions,
  BLOCK_AI_SURFACE_PROMPT,
  type BlockAiPromptRequest,
  type AssemblerFn,
} from '../renderer/block-ai-prompt-handler';

import type { AssemblyRequest } from '../main/prompts/assemble';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

/** Minimal toggle-off request — all optional fields absent. */
const TOGGLE_OFF_MINIMAL: BlockAiPromptRequest = {
  toggleEnabled: false,
};

/** Toggle-off request with quality directive. */
const TOGGLE_OFF_WITH_QUALITY: BlockAiPromptRequest = {
  toggleEnabled: false,
  qualityDirectiveStr: 'Write at a professional level.',
};

/** Fully-populated toggle-on request. */
const TOGGLE_ON_FULL: BlockAiPromptRequest = {
  toggleEnabled: true,
  systemlawContent: '# Systemlaw\nBe helpful.',
  ownerContent: '# Owner\nI am a professional writer.',
  qualityDirectiveStr: 'Write at a college level.',
  documentText: '## Section\nSome context.',
};

/** Toggle-on request with minimal content (omitting optional fields). */
const TOGGLE_ON_MINIMAL: BlockAiPromptRequest = {
  toggleEnabled: true,
};

// Mock assembler — returns a fixed string so tests can assert on the return value.
const MOCK_ASSEMBLED = 'mock-assembled-prompt';
let mockAssembler: ReturnType<typeof vi.fn<[AssemblyRequest], string>>;

beforeEach(() => {
  mockAssembler = vi.fn<[AssemblyRequest], string>().mockReturnValue(MOCK_ASSEMBLED);
});

// ---------------------------------------------------------------------------
// A. Toggle-off path — legacy v1.0 string returned; assembler not called
// ---------------------------------------------------------------------------

describe('A: toggle-off path → legacy string, assembler not called', () => {
  it('returns a non-empty string when toggle is off (minimal request)', () => {
    const result = buildBlockAiInstructions(TOGGLE_OFF_MINIMAL, mockAssembler);
    expect(typeof result).toBe('string');
    expect(result.trim().length).toBeGreaterThan(0);
  });

  it('does NOT call the assembler when toggle is off', () => {
    buildBlockAiInstructions(TOGGLE_OFF_MINIMAL, mockAssembler);
    expect(mockAssembler).not.toHaveBeenCalled();
  });

  it('does NOT call the assembler even when all content fields are provided', () => {
    buildBlockAiInstructions(
      { ...TOGGLE_OFF_MINIMAL, systemlawContent: 'law', ownerContent: 'owner' },
      mockAssembler,
    );
    expect(mockAssembler).not.toHaveBeenCalled();
  });

  it('does NOT call the assembler when toggle is off with quality directive', () => {
    buildBlockAiInstructions(TOGGLE_OFF_WITH_QUALITY, mockAssembler);
    expect(mockAssembler).not.toHaveBeenCalled();
  });

  it('does NOT call the assembler regardless of qualityDirectiveStr value', () => {
    const variants: BlockAiPromptRequest[] = [
      { toggleEnabled: false, qualityDirectiveStr: '' },
      { toggleEnabled: false, qualityDirectiveStr: 'Write simply.' },
      { toggleEnabled: false, qualityDirectiveStr: '   ' },
    ];
    for (const req of variants) {
      buildBlockAiInstructions(req, mockAssembler);
    }
    expect(mockAssembler).not.toHaveBeenCalled();
  });

  it('result contains BLOCK_AI_SURFACE_PROMPT when toggle is off', () => {
    const result = buildBlockAiInstructions(TOGGLE_OFF_MINIMAL, mockAssembler);
    expect(result).toContain(BLOCK_AI_SURFACE_PROMPT);
  });

  it('result is exactly BLOCK_AI_SURFACE_PROMPT when no quality directive', () => {
    const result = buildBlockAiInstructions(TOGGLE_OFF_MINIMAL, mockAssembler);
    expect(result).toBe(BLOCK_AI_SURFACE_PROMPT);
  });

  it('result includes quality directive when provided', () => {
    const q = 'Write at a professional level.';
    const result = buildBlockAiInstructions({ toggleEnabled: false, qualityDirectiveStr: q }, mockAssembler);
    expect(result).toContain(q);
    expect(result).toContain(BLOCK_AI_SURFACE_PROMPT);
  });

  it('result is stable across multiple calls with same input', () => {
    const first = buildBlockAiInstructions(TOGGLE_OFF_WITH_QUALITY, mockAssembler);
    const second = buildBlockAiInstructions(TOGGLE_OFF_WITH_QUALITY, mockAssembler);
    expect(first).toBe(second);
  });
});

// ---------------------------------------------------------------------------
// B. Toggle-on path — assembler called; its return value forwarded
// ---------------------------------------------------------------------------

describe('B: toggle-on path → assembler called, return value forwarded', () => {
  it('calls the assembler exactly once when toggle is on', () => {
    buildBlockAiInstructions(TOGGLE_ON_FULL, mockAssembler);
    expect(mockAssembler).toHaveBeenCalledTimes(1);
  });

  it('returns the assembler return value verbatim when toggle is on', () => {
    const result = buildBlockAiInstructions(TOGGLE_ON_FULL, mockAssembler);
    expect(result).toBe(MOCK_ASSEMBLED);
  });

  it('forwards custom assembler return value when toggle is on', () => {
    mockAssembler.mockReturnValue('custom-assembled-output');
    const result = buildBlockAiInstructions(TOGGLE_ON_MINIMAL, mockAssembler);
    expect(result).toBe('custom-assembled-output');
  });

  it('forwards empty string from assembler when toggle is on (assembler may return empty)', () => {
    mockAssembler.mockReturnValue('');
    const result = buildBlockAiInstructions(TOGGLE_ON_MINIMAL, mockAssembler);
    expect(result).toBe('');
  });

  it('calls the assembler once even for minimal (all-empty) toggle-on request', () => {
    buildBlockAiInstructions(TOGGLE_ON_MINIMAL, mockAssembler);
    expect(mockAssembler).toHaveBeenCalledTimes(1);
  });

  it('calls the assembler once per invocation across multiple calls', () => {
    buildBlockAiInstructions(TOGGLE_ON_FULL, mockAssembler);
    buildBlockAiInstructions(TOGGLE_ON_MINIMAL, mockAssembler);
    expect(mockAssembler).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// C. Assembler args — correct AssemblyRequest built for toggle-on
// ---------------------------------------------------------------------------

describe('C: assembler receives correct AssemblyRequest when toggle is on', () => {
  it('assembler is called with surface = "BlockAI"', () => {
    buildBlockAiInstructions(TOGGLE_ON_FULL, mockAssembler);
    const [req] = mockAssembler.mock.calls[0];
    expect(req.surface).toBe('BlockAI');
  });

  it('assembler receives the provided systemlawContent', () => {
    buildBlockAiInstructions(TOGGLE_ON_FULL, mockAssembler);
    const [req] = mockAssembler.mock.calls[0];
    expect(req.systemlawContent).toBe('# Systemlaw\nBe helpful.');
  });

  it('assembler receives the provided ownerContent', () => {
    buildBlockAiInstructions(TOGGLE_ON_FULL, mockAssembler);
    const [req] = mockAssembler.mock.calls[0];
    expect(req.ownerContent).toBe('# Owner\nI am a professional writer.');
  });

  it('assembler receives BLOCK_AI_SURFACE_PROMPT as surfacePrompt', () => {
    buildBlockAiInstructions(TOGGLE_ON_FULL, mockAssembler);
    const [req] = mockAssembler.mock.calls[0];
    expect(req.surfacePrompt).toBe(BLOCK_AI_SURFACE_PROMPT);
  });

  it('assembler receives the provided qualityDirective', () => {
    buildBlockAiInstructions(TOGGLE_ON_FULL, mockAssembler);
    const [req] = mockAssembler.mock.calls[0];
    expect(req.qualityDirective).toBe('Write at a college level.');
  });

  it('assembler receives the provided documentText', () => {
    buildBlockAiInstructions(TOGGLE_ON_FULL, mockAssembler);
    const [req] = mockAssembler.mock.calls[0];
    expect(req.documentText).toBe('## Section\nSome context.');
  });

  it('assembler receives empty string for systemlawContent when omitted', () => {
    buildBlockAiInstructions(TOGGLE_ON_MINIMAL, mockAssembler);
    const [req] = mockAssembler.mock.calls[0];
    expect(req.systemlawContent).toBe('');
  });

  it('assembler receives empty string for ownerContent when omitted', () => {
    buildBlockAiInstructions(TOGGLE_ON_MINIMAL, mockAssembler);
    const [req] = mockAssembler.mock.calls[0];
    expect(req.ownerContent).toBe('');
  });

  it('assembler receives empty string for qualityDirective when omitted', () => {
    buildBlockAiInstructions(TOGGLE_ON_MINIMAL, mockAssembler);
    const [req] = mockAssembler.mock.calls[0];
    expect(req.qualityDirective).toBe('');
  });

  it('assembler receives empty string for documentText when omitted', () => {
    buildBlockAiInstructions(TOGGLE_ON_MINIMAL, mockAssembler);
    const [req] = mockAssembler.mock.calls[0];
    expect(req.documentText).toBe('');
  });

  it('assembler receives BLOCK_AI_SURFACE_PROMPT even for minimal request', () => {
    buildBlockAiInstructions(TOGGLE_ON_MINIMAL, mockAssembler);
    const [req] = mockAssembler.mock.calls[0];
    expect(req.surfacePrompt).toBe(BLOCK_AI_SURFACE_PROMPT);
  });
});

// ---------------------------------------------------------------------------
// D. Legacy string — exact legacy concatenation for toggle-off
// ---------------------------------------------------------------------------

describe('D: legacy path produces correct v1.0 string', () => {
  it('legacy with no quality = only BLOCK_AI_SURFACE_PROMPT', () => {
    const result = buildBlockAiInstructions({ toggleEnabled: false }, mockAssembler);
    expect(result).toBe(BLOCK_AI_SURFACE_PROMPT);
  });

  it('legacy with quality = surface_prompt + \\n\\n + quality', () => {
    const q = 'Write at a professional level.';
    const result = buildBlockAiInstructions({ toggleEnabled: false, qualityDirectiveStr: q }, mockAssembler);
    expect(result).toBe(`${BLOCK_AI_SURFACE_PROMPT}\n\n${q}`);
  });

  it('legacy with empty quality string = only BLOCK_AI_SURFACE_PROMPT', () => {
    const result = buildBlockAiInstructions({ toggleEnabled: false, qualityDirectiveStr: '' }, mockAssembler);
    expect(result).toBe(BLOCK_AI_SURFACE_PROMPT);
  });

  it('legacy with whitespace-only quality = only BLOCK_AI_SURFACE_PROMPT (whitespace filtered)', () => {
    const result = buildBlockAiInstructions({ toggleEnabled: false, qualityDirectiveStr: '   ' }, mockAssembler);
    expect(result).toBe(BLOCK_AI_SURFACE_PROMPT);
  });

  it('legacy path ignores systemlawContent (not part of v1.0 output)', () => {
    const result = buildBlockAiInstructions(
      { toggleEnabled: false, systemlawContent: '# Law\nBe helpful.', qualityDirectiveStr: '' },
      mockAssembler,
    );
    expect(result).not.toContain('# Law');
    expect(result).toBe(BLOCK_AI_SURFACE_PROMPT);
  });

  it('legacy path ignores ownerContent (not part of v1.0 output)', () => {
    const result = buildBlockAiInstructions(
      { toggleEnabled: false, ownerContent: '# Owner\nWriter.', qualityDirectiveStr: '' },
      mockAssembler,
    );
    expect(result).not.toContain('# Owner');
    expect(result).toBe(BLOCK_AI_SURFACE_PROMPT);
  });

  it('legacy path separator is exactly \\n\\n (double newline)', () => {
    const q = 'quality';
    const result = buildBlockAiInstructions({ toggleEnabled: false, qualityDirectiveStr: q }, mockAssembler);
    // Should contain exactly \n\n between surface prompt and quality
    const expected = `${BLOCK_AI_SURFACE_PROMPT}\n\nquality`;
    expect(result).toBe(expected);
    // Verify there's no extra newline
    expect(result).not.toContain('\n\n\n');
  });

  it('different quality strings produce distinct legacy outputs', () => {
    const r1 = buildBlockAiInstructions({ toggleEnabled: false, qualityDirectiveStr: 'Write simply.' }, mockAssembler);
    const r2 = buildBlockAiInstructions({ toggleEnabled: false, qualityDirectiveStr: 'Write formally.' }, mockAssembler);
    expect(r1).not.toBe(r2);
    expect(r1).toContain('Write simply.');
    expect(r2).toContain('Write formally.');
  });
});

// ---------------------------------------------------------------------------
// E. Cross-branch isolation
// ---------------------------------------------------------------------------

describe('E: cross-branch isolation', () => {
  it('toggle-on result does NOT equal the legacy string when assembler returns something', () => {
    mockAssembler.mockReturnValue('assembled-result');
    const onResult = buildBlockAiInstructions(TOGGLE_ON_FULL, mockAssembler);
    const offResult = buildBlockAiInstructions({ ...TOGGLE_ON_FULL, toggleEnabled: false }, mockAssembler);
    expect(onResult).not.toBe(offResult);
  });

  it('toggle-on result does NOT contain raw BLOCK_AI_SURFACE_PROMPT text (assembler controls output)', () => {
    // Assembler returns something different from the surface prompt
    mockAssembler.mockReturnValue('totally-different-output');
    const result = buildBlockAiInstructions(TOGGLE_ON_FULL, mockAssembler);
    expect(result).not.toContain(BLOCK_AI_SURFACE_PROMPT);
  });

  it('toggle-off result does NOT contain systemlawContent text', () => {
    const result = buildBlockAiInstructions(
      { toggleEnabled: false, systemlawContent: 'unique-systemlaw-text-xyz' },
      mockAssembler,
    );
    expect(result).not.toContain('unique-systemlaw-text-xyz');
  });

  it('toggle-off result does NOT contain ownerContent text', () => {
    const result = buildBlockAiInstructions(
      { toggleEnabled: false, ownerContent: 'unique-owner-text-abc' },
      mockAssembler,
    );
    expect(result).not.toContain('unique-owner-text-abc');
  });

  it('interleaved calls: on then off produce assembler-call then no-assembler-call', () => {
    buildBlockAiInstructions(TOGGLE_ON_MINIMAL, mockAssembler);
    buildBlockAiInstructions(TOGGLE_OFF_MINIMAL, mockAssembler);
    // Assembler was called once total (only for the toggle-on call)
    expect(mockAssembler).toHaveBeenCalledTimes(1);
  });

  it('interleaved calls: off then on produce no-assembler then assembler-call', () => {
    buildBlockAiInstructions(TOGGLE_OFF_MINIMAL, mockAssembler);
    buildBlockAiInstructions(TOGGLE_ON_MINIMAL, mockAssembler);
    expect(mockAssembler).toHaveBeenCalledTimes(1);
  });

  it('multiple toggle-off calls never call the assembler', () => {
    for (let i = 0; i < 5; i++) {
      buildBlockAiInstructions(TOGGLE_OFF_MINIMAL, mockAssembler);
    }
    expect(mockAssembler).not.toHaveBeenCalled();
  });

  it('multiple toggle-on calls all call the assembler', () => {
    for (let i = 0; i < 4; i++) {
      buildBlockAiInstructions(TOGGLE_ON_MINIMAL, mockAssembler);
    }
    expect(mockAssembler).toHaveBeenCalledTimes(4);
  });
});

// ---------------------------------------------------------------------------
// F. Edge cases
// ---------------------------------------------------------------------------

describe('F: edge cases', () => {
  it('toggle-off with undefined qualityDirectiveStr does not throw', () => {
    expect(() => {
      buildBlockAiInstructions({ toggleEnabled: false, qualityDirectiveStr: undefined }, mockAssembler);
    }).not.toThrow();
  });

  it('toggle-on with all undefined optional fields does not throw', () => {
    expect(() => {
      buildBlockAiInstructions({ toggleEnabled: true }, mockAssembler);
    }).not.toThrow();
  });

  it('toggle-off with all undefined optional fields returns BLOCK_AI_SURFACE_PROMPT', () => {
    const result = buildBlockAiInstructions({ toggleEnabled: false }, mockAssembler);
    expect(result).toBe(BLOCK_AI_SURFACE_PROMPT);
  });

  it('toggle-on: assembler called with empty strings for undefined optional fields', () => {
    buildBlockAiInstructions({ toggleEnabled: true }, mockAssembler);
    const [req] = mockAssembler.mock.calls[0];
    expect(req.systemlawContent).toBe('');
    expect(req.ownerContent).toBe('');
    expect(req.qualityDirective).toBe('');
    expect(req.documentText).toBe('');
  });

  it('quality directive with Korean text is preserved in legacy path', () => {
    const q = '초등학교 수준으로 작성하세요.';
    const result = buildBlockAiInstructions({ toggleEnabled: false, qualityDirectiveStr: q }, mockAssembler);
    expect(result).toContain(q);
  });

  it('quality directive with Korean text is forwarded to assembler in new path', () => {
    const q = '전문적인 수준으로 작성하세요.';
    buildBlockAiInstructions({ toggleEnabled: true, qualityDirectiveStr: q }, mockAssembler);
    const [req] = mockAssembler.mock.calls[0];
    expect(req.qualityDirective).toBe(q);
  });

  it('long systemlawContent is passed through to assembler without truncation', () => {
    const long = 'rule '.repeat(1000).trim();
    buildBlockAiInstructions({ toggleEnabled: true, systemlawContent: long }, mockAssembler);
    const [req] = mockAssembler.mock.calls[0];
    expect(req.systemlawContent).toBe(long);
  });

  it('empty string systemlawContent is forwarded as empty string to assembler', () => {
    buildBlockAiInstructions({ toggleEnabled: true, systemlawContent: '' }, mockAssembler);
    const [req] = mockAssembler.mock.calls[0];
    expect(req.systemlawContent).toBe('');
  });

  it('does not throw when assembler throws — actually: assembler errors propagate', () => {
    // The handler does not swallow assembler errors — if assemble() throws,
    // the error propagates to the caller as expected.
    mockAssembler.mockImplementation(() => { throw new Error('assembler error'); });
    expect(() => {
      buildBlockAiInstructions(TOGGLE_ON_MINIMAL, mockAssembler);
    }).toThrow('assembler error');
  });
});

// ---------------------------------------------------------------------------
// G. Default assembler — smoke test (real assemblePrompt used when no 2nd arg)
// ---------------------------------------------------------------------------

describe('G: default assembler smoke test', () => {
  it('toggle-off with default assembler: does not throw', () => {
    expect(() => {
      buildBlockAiInstructions({ toggleEnabled: false });
    }).not.toThrow();
  });

  it('toggle-off with default assembler: returns BLOCK_AI_SURFACE_PROMPT', () => {
    const result = buildBlockAiInstructions({ toggleEnabled: false });
    expect(result).toBe(BLOCK_AI_SURFACE_PROMPT);
  });

  it('toggle-on with default assembler: does not throw', () => {
    expect(() => {
      buildBlockAiInstructions({
        toggleEnabled: true,
        systemlawContent: '# Law',
        ownerContent: '# Owner',
        qualityDirectiveStr: 'Write professionally.',
      });
    }).not.toThrow();
  });

  it('toggle-on with default assembler: returns a non-empty string', () => {
    const result = buildBlockAiInstructions({
      toggleEnabled: true,
      systemlawContent: '# Law\nBe helpful.',
      ownerContent: '# Owner\nProfessional writer.',
      qualityDirectiveStr: 'Write at a college level.',
    });
    expect(typeof result).toBe('string');
    expect(result.trim().length).toBeGreaterThan(0);
  });

  it('toggle-on with default assembler: result contains BLOCK_AI_SURFACE_PROMPT', () => {
    const result = buildBlockAiInstructions({
      toggleEnabled: true,
      systemlawContent: '# Law',
      qualityDirectiveStr: 'Write at a professional level.',
    });
    expect(result).toContain(BLOCK_AI_SURFACE_PROMPT);
  });
});

// ---------------------------------------------------------------------------
// H. Type conformance
// ---------------------------------------------------------------------------

describe('H: type conformance', () => {
  it('AssemblerFn accepts an AssemblyRequest and returns string', () => {
    const emitter: AssemblerFn = (req) => {
      expect(req).toBeDefined();
      expect(req.surface).toBe('BlockAI');
      return 'typed-result';
    };
    const result = buildBlockAiInstructions(TOGGLE_ON_MINIMAL, emitter);
    expect(result).toBe('typed-result');
  });

  it('BlockAiPromptRequest with only toggleEnabled is a valid type', () => {
    const req: BlockAiPromptRequest = { toggleEnabled: false };
    expect(() => buildBlockAiInstructions(req, mockAssembler)).not.toThrow();
  });

  it('BlockAiPromptRequest with all fields populated is a valid type', () => {
    const req: BlockAiPromptRequest = {
      toggleEnabled: true,
      systemlawContent: 'law',
      ownerContent: 'owner',
      qualityDirectiveStr: 'quality',
      documentText: 'document',
    };
    expect(() => buildBlockAiInstructions(req, mockAssembler)).not.toThrow();
  });

  it('BLOCK_AI_SURFACE_PROMPT is a non-empty string', () => {
    expect(typeof BLOCK_AI_SURFACE_PROMPT).toBe('string');
    expect(BLOCK_AI_SURFACE_PROMPT.trim().length).toBeGreaterThan(0);
  });

  it('BLOCK_AI_SURFACE_PROMPT contains the "Markdown editor" reference', () => {
    expect(BLOCK_AI_SURFACE_PROMPT).toContain('Markdown editor');
  });

  it('BLOCK_AI_SURFACE_PROMPT mentions producing 3 alternatives', () => {
    expect(BLOCK_AI_SURFACE_PROMPT).toContain('3');
  });
});
