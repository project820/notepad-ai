/**
 * side-chat-adapter.test.ts
 *
 * Unit tests for `buildSideChatInstructions(req, assemble?)`.
 *
 * Sub-AC 6.3b requirements:
 *   ✓ The Side Chat surface adapter does not throw when the injected assembler
 *     returns a fallback-only stack.
 *   ✓ The Side Chat surface adapter returns a non-empty string when the injected
 *     assembler returns a fallback-only stack.
 *   ✓ Verified by at least one unit test covering both no-throw AND
 *     non-empty-string assertions.
 *
 * "Fallback-only stack" — the assembled string returned by `assemblePrompt`
 * when both userData readers return their defaults (no systemlaw.md, no Owner.md).
 * For testing purposes we simulate this with a representative non-empty string
 * that mirrors what the real assembler would produce in that scenario.
 *
 * Test groups:
 *   A. no-throw guarantee  — adapter never throws regardless of inputs
 *   B. fallback-only stack — primary AC requirement: assembler mock → non-empty string
 *   C. toggle-OFF path     — v1.0 legacy string returned; assembler never called
 *   D. toggle-ON path      — assembler is called with correct AssemblyRequest
 *   E. empty / partial params — graceful handling of missing fields
 *   F. assembler injection — default and mock assemblers behave correctly
 *   G. return-type guarantees — result is always a string
 *   H. legacy document section — document context formatted with === markers
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  buildSideChatInstructions,
  SIDE_CHAT_SURFACE_PROMPT,
  type SideChatPromptRequest,
  type AssemblerFn,
} from '../renderer/side-chat-adapter';

import type { AssemblyRequest } from '../main/prompts/assemble';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

/** Minimal toggle-off request — all optional fields absent. */
const TOGGLE_OFF_MINIMAL: SideChatPromptRequest = {
  toggleEnabled: false,
};

/** Toggle-off request with quality directive and document text. */
const TOGGLE_OFF_FULL: SideChatPromptRequest = {
  toggleEnabled: false,
  qualityDirectiveStr: 'Write at a professional level.',
  documentText: '# My Report\nQ1 results show 15% growth.',
};

/** Fully-populated toggle-on request. */
const TOGGLE_ON_FULL: SideChatPromptRequest = {
  toggleEnabled: true,
  systemlawContent: '# Systemlaw\nBe helpful.',
  ownerContent: '# Owner\nI am a professional writer.',
  qualityDirectiveStr: 'Write at a college level.',
  documentText: '## Section\nSome context.',
};

/** Toggle-on request with minimal content (omitting optional fields). */
const TOGGLE_ON_MINIMAL: SideChatPromptRequest = {
  toggleEnabled: true,
};

// ---------------------------------------------------------------------------
// Fallback-only stack fixture
// ---------------------------------------------------------------------------

/**
 * Representative fallback-only stack content.
 *
 * In a real pipeline this is what `assemblePrompt` returns when both
 * userData files are absent (readers return their built-in defaults).
 * Using a labeled string here keeps tests readable and verifies the adapter
 * passes through the assembler's output without modification.
 */
const FALLBACK_ONLY_STACK =
  `# AI Conduct Rules\nBe concise. Respond in the user's language.\n\n` +
  `# About the Author\nName: (not yet configured)\n` +
  `Role: (not yet configured)\n\n` +
  `You are an editorial consultant embedded in a Markdown editor.`;

// Mock assembler that returns the fallback-only stack.
let mockAssembler: ReturnType<typeof vi.fn<[AssemblyRequest], string>>;

beforeEach(() => {
  mockAssembler = vi.fn<[AssemblyRequest], string>().mockReturnValue(FALLBACK_ONLY_STACK);
});

// ===========================================================================
// A. no-throw guarantee — adapter never throws regardless of inputs
// ===========================================================================

describe('A: no-throw guarantee — adapter never throws', () => {
  it('A1. [toggle-ON, fallback assembler] does not throw with minimal params', () => {
    expect(() => buildSideChatInstructions(TOGGLE_ON_MINIMAL, mockAssembler)).not.toThrow();
  });

  it('A2. [toggle-ON, fallback assembler] does not throw with full params', () => {
    expect(() => buildSideChatInstructions(TOGGLE_ON_FULL, mockAssembler)).not.toThrow();
  });

  it('A3. [toggle-OFF] does not throw with minimal params', () => {
    expect(() => buildSideChatInstructions(TOGGLE_OFF_MINIMAL, mockAssembler)).not.toThrow();
  });

  it('A4. [toggle-OFF] does not throw with full params', () => {
    expect(() => buildSideChatInstructions(TOGGLE_OFF_FULL, mockAssembler)).not.toThrow();
  });

  it('A5. [toggle-ON] does not throw when assembler returns empty string', () => {
    const emptyAssembler = vi.fn<[AssemblyRequest], string>().mockReturnValue('');
    expect(() => buildSideChatInstructions(TOGGLE_ON_MINIMAL, emptyAssembler)).not.toThrow();
  });

  it('A6. [toggle-ON] does not throw when all optional params are explicitly empty strings', () => {
    const emptyParams: SideChatPromptRequest = {
      toggleEnabled: true,
      systemlawContent: '',
      ownerContent: '',
      qualityDirectiveStr: '',
      documentText: '',
    };
    expect(() => buildSideChatInstructions(emptyParams, mockAssembler)).not.toThrow();
  });

  it('A7. [toggle-ON] does not throw when optional params are undefined', () => {
    const params: SideChatPromptRequest = {
      toggleEnabled: true,
      systemlawContent: undefined,
      ownerContent: undefined,
      qualityDirectiveStr: undefined,
      documentText: undefined,
    };
    expect(() => buildSideChatInstructions(params, mockAssembler)).not.toThrow();
  });
});

// ===========================================================================
// B. fallback-only stack — PRIMARY AC requirement (Sub-AC 6.3b)
// ===========================================================================

describe('B: fallback-only stack — primary Sub-AC 6.3b requirement', () => {
  /**
   * PRIMARY TEST for Sub-AC 6.3b:
   * When the assembler is mocked to return a fallback-only stack,
   * the Side Chat adapter must (1) not throw, AND (2) return a non-empty string.
   */
  it('B1. [PRIMARY] toggle-ON with fallback assembler: does not throw AND returns non-empty string', () => {
    let result: string | undefined;

    // (1) no-throw assertion
    expect(() => {
      result = buildSideChatInstructions(TOGGLE_ON_MINIMAL, mockAssembler);
    }).not.toThrow();

    // (2) non-empty-string assertion
    expect(typeof result).toBe('string');
    expect((result as string).length).toBeGreaterThan(0);
  });

  it('B2. result equals what the fallback assembler returned (no transformation)', () => {
    const result = buildSideChatInstructions(TOGGLE_ON_MINIMAL, mockAssembler);
    expect(result).toBe(FALLBACK_ONLY_STACK);
  });

  it('B3. result is a string type (not null, undefined, or other)', () => {
    const result = buildSideChatInstructions(TOGGLE_ON_MINIMAL, mockAssembler);
    expect(typeof result).toBe('string');
    expect(result).not.toBeNull();
    expect(result).not.toBeUndefined();
  });

  it('B4. fallback-only stack with full params: does not throw AND returns non-empty string', () => {
    let result: string | undefined;
    expect(() => {
      result = buildSideChatInstructions(TOGGLE_ON_FULL, mockAssembler);
    }).not.toThrow();
    expect(typeof result).toBe('string');
    expect((result as string).length).toBeGreaterThan(0);
  });

  it('B5. assembler is called exactly once per buildSideChatInstructions call (toggle-ON)', () => {
    buildSideChatInstructions(TOGGLE_ON_MINIMAL, mockAssembler);
    expect(mockAssembler).toHaveBeenCalledTimes(1);
  });

  it('B6. assembler is called with surface: "SideChat" (toggle-ON)', () => {
    buildSideChatInstructions(TOGGLE_ON_MINIMAL, mockAssembler);
    expect(mockAssembler).toHaveBeenCalledWith(
      expect.objectContaining({ surface: 'SideChat' }),
    );
  });

  it('B7. fallback-only stack string passes the "usable prompt" bar — trimmed length > 0', () => {
    const result = buildSideChatInstructions(TOGGLE_ON_MINIMAL, mockAssembler);
    expect(result.trim().length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// C. toggle-OFF path — v1.0 legacy string returned; assembler never called
// ===========================================================================

describe('C: toggle-OFF path — v1.0 legacy string, assembler not called', () => {
  it('C1. [toggle-OFF] returns a non-empty string without calling the assembler', () => {
    const result = buildSideChatInstructions(TOGGLE_OFF_MINIMAL, mockAssembler);
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
    expect(mockAssembler).not.toHaveBeenCalled();
  });

  it('C2. [toggle-OFF] result contains SIDE_CHAT_SURFACE_PROMPT verbatim', () => {
    const result = buildSideChatInstructions(TOGGLE_OFF_MINIMAL, mockAssembler);
    expect(result).toContain(SIDE_CHAT_SURFACE_PROMPT);
  });

  it('C3. [toggle-OFF] quality directive is appended when non-empty', () => {
    const q = 'Write at a professional level.';
    const result = buildSideChatInstructions({ toggleEnabled: false, qualityDirectiveStr: q }, mockAssembler);
    expect(result).toContain(q);
    expect(result).toContain(SIDE_CHAT_SURFACE_PROMPT);
  });

  it('C4. [toggle-OFF] document section is always included (falls back to "(empty)")', () => {
    const result = buildSideChatInstructions(TOGGLE_OFF_MINIMAL, mockAssembler);
    expect(result).toContain('=== Current document ===');
    expect(result).toContain('=== End document ===');
  });

  it('C5. [toggle-OFF] document content appears between === markers when provided', () => {
    const doc = '# My Document\nSome content here.';
    const result = buildSideChatInstructions({ toggleEnabled: false, documentText: doc }, mockAssembler);
    expect(result).toContain(`=== Current document ===\n${doc}\n=== End document ===`);
  });

  it('C6. [toggle-OFF] "(empty)" appears when documentText is an empty string', () => {
    const result = buildSideChatInstructions({ toggleEnabled: false, documentText: '' }, mockAssembler);
    expect(result).toContain('(empty)');
  });

  it('C7. [toggle-OFF] systemlawContent and ownerContent are ignored', () => {
    const params: SideChatPromptRequest = {
      toggleEnabled: false,
      systemlawContent: 'SYSTEMLAW_SHOULD_NOT_APPEAR',
      ownerContent: 'OWNER_SHOULD_NOT_APPEAR',
    };
    const result = buildSideChatInstructions(params, mockAssembler);
    expect(result).not.toContain('SYSTEMLAW_SHOULD_NOT_APPEAR');
    expect(result).not.toContain('OWNER_SHOULD_NOT_APPEAR');
  });

  it('C8. [toggle-OFF] assembler is NEVER called regardless of other fields', () => {
    buildSideChatInstructions(TOGGLE_OFF_FULL, mockAssembler);
    expect(mockAssembler).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// D. toggle-ON path — assembler called with correct AssemblyRequest
// ===========================================================================

describe('D: toggle-ON path — assembler receives correct AssemblyRequest', () => {
  it('D1. assembler receives systemlawContent from params', () => {
    buildSideChatInstructions({ toggleEnabled: true, systemlawContent: 'MY_SYSTEMLAW' }, mockAssembler);
    expect(mockAssembler).toHaveBeenCalledWith(
      expect.objectContaining({ systemlawContent: 'MY_SYSTEMLAW' }),
    );
  });

  it('D2. assembler receives ownerContent from params', () => {
    buildSideChatInstructions({ toggleEnabled: true, ownerContent: 'MY_OWNER' }, mockAssembler);
    expect(mockAssembler).toHaveBeenCalledWith(
      expect.objectContaining({ ownerContent: 'MY_OWNER' }),
    );
  });

  it('D3. assembler receives qualityDirective from qualityDirectiveStr param', () => {
    buildSideChatInstructions({ toggleEnabled: true, qualityDirectiveStr: 'QUALITY_DIRECTIVE' }, mockAssembler);
    expect(mockAssembler).toHaveBeenCalledWith(
      expect.objectContaining({ qualityDirective: 'QUALITY_DIRECTIVE' }),
    );
  });

  it('D4. assembler receives documentText from params', () => {
    buildSideChatInstructions({ toggleEnabled: true, documentText: 'DOCUMENT_TEXT' }, mockAssembler);
    expect(mockAssembler).toHaveBeenCalledWith(
      expect.objectContaining({ documentText: 'DOCUMENT_TEXT' }),
    );
  });

  it('D5. assembler receives surfacePrompt = SIDE_CHAT_SURFACE_PROMPT (Layer 3)', () => {
    buildSideChatInstructions(TOGGLE_ON_MINIMAL, mockAssembler);
    expect(mockAssembler).toHaveBeenCalledWith(
      expect.objectContaining({ surfacePrompt: SIDE_CHAT_SURFACE_PROMPT }),
    );
  });

  it('D6. absent params default to empty string in AssemblyRequest', () => {
    const capturedReqs: AssemblyRequest[] = [];
    const capturingAssembler = vi.fn<[AssemblyRequest], string>((req) => {
      capturedReqs.push(req);
      return FALLBACK_ONLY_STACK;
    });
    buildSideChatInstructions(TOGGLE_ON_MINIMAL, capturingAssembler);
    const req = capturedReqs[0];
    expect(req.systemlawContent).toBe('');
    expect(req.ownerContent).toBe('');
    expect(req.qualityDirective).toBe('');
    expect(req.documentText).toBe('');
  });

  it('D7. assembler is called exactly once per invocation (toggle-ON)', () => {
    buildSideChatInstructions(TOGGLE_ON_FULL, mockAssembler);
    expect(mockAssembler).toHaveBeenCalledTimes(1);
  });

  it('D8. assembler returns its value verbatim when toggle is on', () => {
    mockAssembler.mockReturnValue('CUSTOM_OUTPUT');
    const result = buildSideChatInstructions(TOGGLE_ON_MINIMAL, mockAssembler);
    expect(result).toBe('CUSTOM_OUTPUT');
  });
});

// ===========================================================================
// E. empty / partial params — graceful handling
// ===========================================================================

describe('E: empty / partial params — graceful fallback', () => {
  it('E1. [toggle-ON] all-empty params: does not throw, returns string', () => {
    let result: unknown;
    expect(() => {
      result = buildSideChatInstructions({ toggleEnabled: true }, mockAssembler);
    }).not.toThrow();
    expect(typeof result).toBe('string');
  });

  it('E2. [toggle-ON] only documentText provided: does not throw, returns string', () => {
    let result: unknown;
    expect(() => {
      result = buildSideChatInstructions({ toggleEnabled: true, documentText: 'text' }, mockAssembler);
    }).not.toThrow();
    expect(typeof result).toBe('string');
  });

  it('E3. [toggle-ON] only qualityDirectiveStr provided: does not throw, returns string', () => {
    let result: unknown;
    expect(() => {
      result = buildSideChatInstructions({ toggleEnabled: true, qualityDirectiveStr: 'quality' }, mockAssembler);
    }).not.toThrow();
    expect(typeof result).toBe('string');
  });

  it('E4. [toggle-OFF] missing qualityDirectiveStr: result contains surface prompt', () => {
    const result = buildSideChatInstructions({ toggleEnabled: false });
    expect(result).toContain(SIDE_CHAT_SURFACE_PROMPT);
  });

  it('E5. [toggle-ON] whitespace-only qualityDirectiveStr is treated as empty', () => {
    const capturedReqs: AssemblyRequest[] = [];
    const capturingAssembler = vi.fn<[AssemblyRequest], string>((req) => {
      capturedReqs.push(req);
      return FALLBACK_ONLY_STACK;
    });
    buildSideChatInstructions({ toggleEnabled: true, qualityDirectiveStr: '   ' }, capturingAssembler);
    expect(capturedReqs[0].qualityDirective).toBe('');
  });

  it('E6. [toggle-ON] undefined fields do not cause ReferenceError', () => {
    const params: SideChatPromptRequest = {
      toggleEnabled: true,
      systemlawContent: undefined,
      ownerContent: undefined,
      qualityDirectiveStr: undefined,
      documentText: undefined,
    };
    expect(() => buildSideChatInstructions(params, mockAssembler)).not.toThrow();
  });
});

// ===========================================================================
// F. assembler injection — mock vs default
// ===========================================================================

describe('F: assembler injection — mock vs default', () => {
  it('F1. mock assembler is called instead of the real assemblePrompt (toggle-ON)', () => {
    const SENTINEL = 'MOCK_ASSEMBLER_WAS_CALLED';
    const sentinelAssembler = vi.fn<[AssemblyRequest], string>().mockReturnValue(SENTINEL);
    const result = buildSideChatInstructions(TOGGLE_ON_MINIMAL, sentinelAssembler);
    expect(result).toBe(SENTINEL);
    expect(sentinelAssembler).toHaveBeenCalledTimes(1);
  });

  it('F2. mock assembler returning fallback string produces non-empty result (toggle-ON)', () => {
    const result = buildSideChatInstructions(TOGGLE_ON_MINIMAL, mockAssembler);
    expect(result.length).toBeGreaterThan(0);
    expect(result).toBe(FALLBACK_ONLY_STACK);
  });

  it('F3. [toggle-OFF] mock assembler is NEVER called when toggle is off', () => {
    buildSideChatInstructions(TOGGLE_OFF_FULL, mockAssembler);
    expect(mockAssembler).not.toHaveBeenCalled();
  });

  it('F4. toggle flip: assembler called when ON, not called when OFF', () => {
    // Toggle OFF — assembler not called
    buildSideChatInstructions(TOGGLE_OFF_MINIMAL, mockAssembler);
    expect(mockAssembler).toHaveBeenCalledTimes(0);

    // Toggle ON — assembler called once
    buildSideChatInstructions(TOGGLE_ON_MINIMAL, mockAssembler);
    expect(mockAssembler).toHaveBeenCalledTimes(1);

    // Toggle OFF again — assembler not called again
    buildSideChatInstructions(TOGGLE_OFF_MINIMAL, mockAssembler);
    expect(mockAssembler).toHaveBeenCalledTimes(1);  // still 1
  });

  it('F5. multiple toggle-on calls all call the assembler', () => {
    for (let i = 0; i < 4; i++) {
      buildSideChatInstructions(TOGGLE_ON_MINIMAL, mockAssembler);
    }
    expect(mockAssembler).toHaveBeenCalledTimes(4);
  });

  it('F6. multiple toggle-off calls never call the assembler', () => {
    for (let i = 0; i < 5; i++) {
      buildSideChatInstructions(TOGGLE_OFF_MINIMAL, mockAssembler);
    }
    expect(mockAssembler).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// G. return-type guarantees — result is always a string
// ===========================================================================

describe('G: return-type guarantees — result is always a string', () => {
  it('G1. [toggle-OFF, minimal params] returns string', () => {
    const result = buildSideChatInstructions(TOGGLE_OFF_MINIMAL, mockAssembler);
    expect(typeof result).toBe('string');
  });

  it('G2. [toggle-OFF, full params] returns string', () => {
    const result = buildSideChatInstructions(TOGGLE_OFF_FULL, mockAssembler);
    expect(typeof result).toBe('string');
  });

  it('G3. [toggle-ON, fallback assembler] returns string', () => {
    const result = buildSideChatInstructions(TOGGLE_ON_MINIMAL, mockAssembler);
    expect(typeof result).toBe('string');
  });

  it('G4. [toggle-ON, assembler returning ""] returns empty string (never null)', () => {
    const emptyAssembler = vi.fn<[AssemblyRequest], string>().mockReturnValue('');
    const result = buildSideChatInstructions(TOGGLE_ON_MINIMAL, emptyAssembler);
    expect(typeof result).toBe('string');
    expect(result).not.toBeNull();
    expect(result).not.toBeUndefined();
    expect(result).toBe('');
  });

  it('G5. [toggle-OFF] result is always non-empty (surface prompt is always included)', () => {
    const result = buildSideChatInstructions(TOGGLE_OFF_MINIMAL);
    expect(result.trim().length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// H. legacy document section — document context formatted with === markers
// ===========================================================================

describe('H: legacy path document section formatting', () => {
  it('H1. [toggle-OFF] document section uses === markers exactly', () => {
    const doc = 'My document text.';
    const result = buildSideChatInstructions({ toggleEnabled: false, documentText: doc }, mockAssembler);
    const expectedSection = `=== Current document ===\n${doc}\n=== End document ===`;
    expect(result).toContain(expectedSection);
  });

  it('H2. [toggle-OFF] "(empty)" placeholder used when documentText is undefined', () => {
    const result = buildSideChatInstructions({ toggleEnabled: false }, mockAssembler);
    expect(result).toContain('=== Current document ===\n(empty)\n=== End document ===');
  });

  it('H3. [toggle-OFF] "(empty)" placeholder used when documentText is empty string', () => {
    const result = buildSideChatInstructions({ toggleEnabled: false, documentText: '' }, mockAssembler);
    expect(result).toContain('=== Current document ===\n(empty)\n=== End document ===');
  });

  it('H4. [toggle-OFF] "(empty)" placeholder used when documentText is whitespace-only', () => {
    const result = buildSideChatInstructions({ toggleEnabled: false, documentText: '   ' }, mockAssembler);
    expect(result).toContain('(empty)');
  });

  it('H5. [toggle-OFF] Korean document content appears between === markers', () => {
    const doc = '# 제목\n본문 내용입니다.';
    const result = buildSideChatInstructions({ toggleEnabled: false, documentText: doc }, mockAssembler);
    expect(result).toContain(`=== Current document ===\n${doc}\n=== End document ===`);
  });

  it('H6. [toggle-OFF] separator between surface prompt and document section is \\n\\n', () => {
    const result = buildSideChatInstructions({ toggleEnabled: false }, mockAssembler);
    // Surface prompt ends without trailing newlines; section starts with ===
    expect(result).toContain(`${SIDE_CHAT_SURFACE_PROMPT}\n\n=== Current document ===`);
  });

  it('H7. [toggle-OFF] quality and document section both appear with correct ordering', () => {
    const q = 'Write professionally.';
    const doc = 'Some document.';
    const result = buildSideChatInstructions({ toggleEnabled: false, qualityDirectiveStr: q, documentText: doc }, mockAssembler);
    const qPos = result.indexOf(q);
    const docPos = result.indexOf('=== Current document ===');
    // Quality appears before document section
    expect(qPos).toBeLessThan(docPos);
  });
});
