/**
 * side-chat-toggle-off.test.ts
 *
 * Sub-AC 3.3c — Side Chat toggle-off routing branch.
 *
 * Verifies the fallback code path executed when the prompt-assembly feature
 * toggle is DISABLED (`toggleEnabled: false` / `PROMPT_ASSEMBLY_DEFAULT`).
 *
 * Two primary assertions required by Sub-AC 3.3c:
 *   1. The legacy (no prompt-stack) route is taken:
 *        → The injected assembler is NEVER called.
 *        → The output is built from the hardcoded v1.0 surface-prompt string.
 *
 *   2. No systemlaw / Owner content is injected:
 *        → Even when `systemlawContent` and `ownerContent` are supplied to
 *          `buildSideChatInstructions`, they MUST NOT appear in the result.
 *        → The output is byte-identical to the v1.0 concatenation:
 *              `SIDE_CHAT_SURFACE_PROMPT` (+ `\n\n` + quality if non-empty)
 *
 * Secondary assertions (rollback safety):
 *   - Toggle default is off — without any explicit `setPromptAssemblyEnabled`
 *     call the toggle-off path runs automatically.
 *   - Calling `buildSideChatInstructions` with the toggle off does NOT
 *     mutate toggle state.
 *   - Results are stable across multiple calls with the same inputs.
 *
 * Module under test: `src/renderer/side-chat-prompt-handler.ts`
 *   (exports: `buildSideChatInstructions`, `readSideChatToggle`,
 *             `SIDE_CHAT_SURFACE_PROMPT`, `SideChatPromptRequest`, `AssemblerFn`)
 *
 * Test groups:
 *   A. Legacy route taken      — assembler is never called when toggle is off
 *   B. No systemlaw injection  — systemlawContent absent from toggle-off output
 *   C. No Owner injection      — ownerContent absent from toggle-off output
 *   D. Legacy string correctness — output matches exact v1.0 concatenation
 *   E. Rollback safety          — default is off; toggle state unchanged by calls
 *   F. Edge cases               — empty, undefined, whitespace, Korean inputs
 *   G. Isolation from toggle-on — toggle-off path is independent of toggle-on path
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  buildSideChatInstructions,
  readSideChatToggle,
  SIDE_CHAT_SURFACE_PROMPT,
  type SideChatPromptRequest,
  type AssemblerFn,
} from '../renderer/side-chat-prompt-handler';

import {
  isPromptAssemblyEnabled,
  setPromptAssemblyEnabled,
  resetPromptAssembly,
  PROMPT_ASSEMBLY_DEFAULT,
} from '../main/prompts/toggle';

import type { AssemblyRequest } from '../main/prompts/assemble';

// ---------------------------------------------------------------------------
// Test isolation: reset toggle state and all mocks after every test.
// ---------------------------------------------------------------------------

afterEach(() => {
  resetPromptAssembly();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

/** Minimal toggle-off request (only required field). */
const OFF_MINIMAL: SideChatPromptRequest = {
  toggleEnabled: false,
};

/** Toggle-off request with a quality directive only. */
const OFF_WITH_QUALITY: SideChatPromptRequest = {
  toggleEnabled: false,
  qualityDirectiveStr: 'Write at a professional level.',
};

/** Toggle-off request with systemlaw and owner content supplied. */
const OFF_WITH_CONTENT: SideChatPromptRequest = {
  toggleEnabled: false,
  systemlawContent: 'SYSTEMLAW_SENTINEL_3C',
  ownerContent:     'OWNER_SENTINEL_3C',
  qualityDirectiveStr: 'Write simply.',
};

/** Toggle-off request with all optional fields populated. */
const OFF_FULL: SideChatPromptRequest = {
  toggleEnabled: false,
  systemlawContent:    '# Rules\nBe helpful and concise.',
  ownerContent:        '# Author\nSenior Korean writer.',
  qualityDirectiveStr: 'Write at a college reading level.',
  documentText:        '## Introduction\nFirst paragraph here.',
};

/** Sentinel value returned by the mock assembler when it IS called (should never happen). */
const ASSEMBLER_SENTINEL = 'ASSEMBLER_WAS_CALLED_UNEXPECTEDLY_3C';

/** Mock assembler that tracks whether it was called. */
let mockAssembler: ReturnType<typeof vi.fn<[AssemblyRequest], string>>;

beforeEach(() => {
  mockAssembler = vi
    .fn<[AssemblyRequest], string>()
    .mockReturnValue(ASSEMBLER_SENTINEL);
});

// ===========================================================================
// A. Legacy route taken — assembler is NEVER called when toggle is off
// ===========================================================================

describe('A: legacy route taken — assembler never called (toggle OFF)', () => {
  it('A1. assembler is not called for minimal toggle-off request', () => {
    buildSideChatInstructions(OFF_MINIMAL, mockAssembler);
    expect(mockAssembler).not.toHaveBeenCalled();
  });

  it('A2. assembler is not called when systemlawContent is provided', () => {
    buildSideChatInstructions(
      { toggleEnabled: false, systemlawContent: 'any-law-content' },
      mockAssembler,
    );
    expect(mockAssembler).not.toHaveBeenCalled();
  });

  it('A3. assembler is not called when ownerContent is provided', () => {
    buildSideChatInstructions(
      { toggleEnabled: false, ownerContent: 'any-owner-content' },
      mockAssembler,
    );
    expect(mockAssembler).not.toHaveBeenCalled();
  });

  it('A4. assembler is not called when all optional fields are populated', () => {
    buildSideChatInstructions(OFF_FULL, mockAssembler);
    expect(mockAssembler).not.toHaveBeenCalled();
  });

  it('A5. assembler is not called when quality directive is provided', () => {
    buildSideChatInstructions(OFF_WITH_QUALITY, mockAssembler);
    expect(mockAssembler).not.toHaveBeenCalled();
  });

  it('A6. assembler call count stays zero across five consecutive toggle-off calls', () => {
    for (let i = 0; i < 5; i++) {
      buildSideChatInstructions(OFF_MINIMAL, mockAssembler);
    }
    expect(mockAssembler).toHaveBeenCalledTimes(0);
  });

  it('A7. result never contains the assembler sentinel value (assembler never ran)', () => {
    const result = buildSideChatInstructions(OFF_FULL, mockAssembler);
    expect(result).not.toContain(ASSEMBLER_SENTINEL);
  });

  it('A8. result is a string and does not contain the assembler sentinel (non-empty input)', () => {
    const result = buildSideChatInstructions(OFF_WITH_CONTENT, mockAssembler);
    expect(typeof result).toBe('string');
    expect(result).not.toContain(ASSEMBLER_SENTINEL);
  });

  it('A9. toggle-off routes to the legacy path even after a toggle-on call resets to off', () => {
    // Simulate a toggle-on / toggle-off lifecycle
    setPromptAssemblyEnabled(true);
    setPromptAssemblyEnabled(false);
    buildSideChatInstructions(OFF_MINIMAL, mockAssembler);
    expect(mockAssembler).not.toHaveBeenCalled();
  });

  it('A10. legacy path result is always non-empty (surface prompt guaranteed)', () => {
    const result = buildSideChatInstructions(OFF_MINIMAL, mockAssembler);
    expect(result.trim().length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// B. No systemlaw injection — systemlawContent absent from toggle-off output
// ===========================================================================

describe('B: no systemlaw injection — systemlawContent absent from toggle-off output', () => {
  it('B1. output does NOT contain systemlawContent text when toggle is off', () => {
    const result = buildSideChatInstructions(
      { toggleEnabled: false, systemlawContent: 'SYSTEMLAW_SENTINEL_3C' },
      mockAssembler,
    );
    expect(result).not.toContain('SYSTEMLAW_SENTINEL_3C');
  });

  it('B2. output does NOT contain systemlawContent even when full content is provided', () => {
    const result = buildSideChatInstructions(OFF_FULL, mockAssembler);
    expect(result).not.toContain('# Rules');
    expect(result).not.toContain('Be helpful and concise.');
  });

  it('B3. output does NOT contain "systemlaw" keyword when toggle is off', () => {
    const result = buildSideChatInstructions(
      { toggleEnabled: false, systemlawContent: 'systemlaw important rule' },
      mockAssembler,
    );
    expect(result).not.toContain('systemlaw important rule');
  });

  it('B4. output is exactly SIDE_CHAT_SURFACE_PROMPT when only systemlawContent provided', () => {
    const result = buildSideChatInstructions(
      { toggleEnabled: false, systemlawContent: 'SYSTEMLAW_SENTINEL_3C' },
      mockAssembler,
    );
    expect(result).toBe(SIDE_CHAT_SURFACE_PROMPT);
  });

  it('B5. output does NOT contain a large systemlaw block when toggle is off', () => {
    const largeLaw = '# AI Conduct Rules\n' + 'rule '.repeat(500).trim();
    const result = buildSideChatInstructions(
      { toggleEnabled: false, systemlawContent: largeLaw },
      mockAssembler,
    );
    expect(result).not.toContain('AI Conduct Rules');
    expect(result).not.toContain('rule rule rule');
  });

  it('B6. output with quality directive does NOT include systemlawContent text', () => {
    const result = buildSideChatInstructions(
      {
        toggleEnabled: false,
        systemlawContent: 'UNIQUE_SYSTEMLAW_B6',
        qualityDirectiveStr: 'Write professionally.',
      },
      mockAssembler,
    );
    expect(result).not.toContain('UNIQUE_SYSTEMLAW_B6');
    expect(result).toContain('Write professionally.');
  });

  it('B7. result length does NOT increase when systemlawContent is provided (content ignored)', () => {
    const withoutSystemlaw = buildSideChatInstructions(OFF_MINIMAL, mockAssembler);
    const withSystemlaw = buildSideChatInstructions(
      { toggleEnabled: false, systemlawContent: 'LARGE_SYSTEMLAW_CONTENT_' + 'x'.repeat(500) },
      mockAssembler,
    );
    // Both results should be the same length — systemlaw is completely ignored
    expect(withSystemlaw).toBe(withoutSystemlaw);
  });
});

// ===========================================================================
// C. No Owner injection — ownerContent absent from toggle-off output
// ===========================================================================

describe('C: no Owner injection — ownerContent absent from toggle-off output', () => {
  it('C1. output does NOT contain ownerContent text when toggle is off', () => {
    const result = buildSideChatInstructions(
      { toggleEnabled: false, ownerContent: 'OWNER_SENTINEL_3C' },
      mockAssembler,
    );
    expect(result).not.toContain('OWNER_SENTINEL_3C');
  });

  it('C2. output does NOT contain ownerContent even when full content is provided', () => {
    const result = buildSideChatInstructions(OFF_FULL, mockAssembler);
    expect(result).not.toContain('# Author');
    expect(result).not.toContain('Senior Korean writer.');
  });

  it('C3. output is exactly SIDE_CHAT_SURFACE_PROMPT when only ownerContent provided', () => {
    const result = buildSideChatInstructions(
      { toggleEnabled: false, ownerContent: 'OWNER_SENTINEL_3C' },
      mockAssembler,
    );
    expect(result).toBe(SIDE_CHAT_SURFACE_PROMPT);
  });

  it('C4. output does NOT contain a large Owner block when toggle is off', () => {
    const largeOwner = '# About the Author\n' + 'detail '.repeat(500).trim();
    const result = buildSideChatInstructions(
      { toggleEnabled: false, ownerContent: largeOwner },
      mockAssembler,
    );
    expect(result).not.toContain('About the Author');
    expect(result).not.toContain('detail detail detail');
  });

  it('C5. result with quality does NOT include ownerContent text', () => {
    const result = buildSideChatInstructions(
      {
        toggleEnabled: false,
        ownerContent: 'UNIQUE_OWNER_C5',
        qualityDirectiveStr: 'Write professionally.',
      },
      mockAssembler,
    );
    expect(result).not.toContain('UNIQUE_OWNER_C5');
    expect(result).toContain('Write professionally.');
  });

  it('C6. result with both systemlaw and owner: neither appears in output', () => {
    const result = buildSideChatInstructions(
      {
        toggleEnabled: false,
        systemlawContent: 'UNIQUE_SYSTEMLAW_C6',
        ownerContent:     'UNIQUE_OWNER_C6',
      },
      mockAssembler,
    );
    expect(result).not.toContain('UNIQUE_SYSTEMLAW_C6');
    expect(result).not.toContain('UNIQUE_OWNER_C6');
  });

  it('C7. result length does NOT increase when ownerContent is provided (content ignored)', () => {
    const withoutOwner = buildSideChatInstructions(OFF_MINIMAL, mockAssembler);
    const withOwner = buildSideChatInstructions(
      { toggleEnabled: false, ownerContent: 'LARGE_OWNER_CONTENT_' + 'y'.repeat(500) },
      mockAssembler,
    );
    expect(withOwner).toBe(withoutOwner);
  });
});

// ===========================================================================
// D. Legacy string correctness — output matches exact v1.0 concatenation
// ===========================================================================

describe('D: legacy string correctness — byte-identical v1.0 output', () => {
  it('D1. result is exactly SIDE_CHAT_SURFACE_PROMPT when no quality directive', () => {
    const result = buildSideChatInstructions(OFF_MINIMAL, mockAssembler);
    expect(result).toBe(SIDE_CHAT_SURFACE_PROMPT);
  });

  it('D2. result contains SIDE_CHAT_SURFACE_PROMPT in all toggle-off scenarios', () => {
    const variants: SideChatPromptRequest[] = [
      OFF_MINIMAL,
      OFF_WITH_QUALITY,
      OFF_WITH_CONTENT,
      OFF_FULL,
      { toggleEnabled: false, qualityDirectiveStr: '' },
      { toggleEnabled: false, documentText: 'some doc' },
    ];
    for (const req of variants) {
      const result = buildSideChatInstructions(req, mockAssembler);
      expect(result).toContain(SIDE_CHAT_SURFACE_PROMPT);
    }
  });

  it('D3. result with quality = SIDE_CHAT_SURFACE_PROMPT + \\n\\n + quality', () => {
    const q = 'Write at a professional level.';
    const result = buildSideChatInstructions(
      { toggleEnabled: false, qualityDirectiveStr: q },
      mockAssembler,
    );
    expect(result).toBe(`${SIDE_CHAT_SURFACE_PROMPT}\n\n${q}`);
  });

  it('D4. result with empty quality = exactly SIDE_CHAT_SURFACE_PROMPT', () => {
    const result = buildSideChatInstructions(
      { toggleEnabled: false, qualityDirectiveStr: '' },
      mockAssembler,
    );
    expect(result).toBe(SIDE_CHAT_SURFACE_PROMPT);
  });

  it('D5. result with whitespace-only quality = exactly SIDE_CHAT_SURFACE_PROMPT', () => {
    const result = buildSideChatInstructions(
      { toggleEnabled: false, qualityDirectiveStr: '   ' },
      mockAssembler,
    );
    expect(result).toBe(SIDE_CHAT_SURFACE_PROMPT);
  });

  it('D6. separator between surface prompt and quality is exactly \\n\\n', () => {
    const q = 'quality-directive-sentinel';
    const result = buildSideChatInstructions(
      { toggleEnabled: false, qualityDirectiveStr: q },
      mockAssembler,
    );
    const expected = `${SIDE_CHAT_SURFACE_PROMPT}\n\n${q}`;
    expect(result).toBe(expected);
    // No triple newline — exactly one \n\n between the two parts
    expect(result).not.toContain('\n\n\n');
  });

  it('D7. different quality values produce distinct legacy strings', () => {
    const r1 = buildSideChatInstructions(
      { toggleEnabled: false, qualityDirectiveStr: 'Write simply.' },
      mockAssembler,
    );
    const r2 = buildSideChatInstructions(
      { toggleEnabled: false, qualityDirectiveStr: 'Write at a PhD level.' },
      mockAssembler,
    );
    expect(r1).not.toBe(r2);
    expect(r1).toContain('Write simply.');
    expect(r2).toContain('Write at a PhD level.');
  });

  it('D8. result starts with SIDE_CHAT_SURFACE_PROMPT (surface prompt is first)', () => {
    const result = buildSideChatInstructions(OFF_WITH_QUALITY, mockAssembler);
    expect(result.startsWith(SIDE_CHAT_SURFACE_PROMPT)).toBe(true);
  });

  it('D9. result is stable — identical inputs produce identical output on repeated calls', () => {
    const first  = buildSideChatInstructions(OFF_WITH_QUALITY, mockAssembler);
    const second = buildSideChatInstructions(OFF_WITH_QUALITY, mockAssembler);
    const third  = buildSideChatInstructions(OFF_WITH_QUALITY, mockAssembler);
    expect(first).toBe(second);
    expect(second).toBe(third);
  });

  it('D10. result is a string type — never null, undefined, or other', () => {
    const result = buildSideChatInstructions(OFF_FULL, mockAssembler);
    expect(typeof result).toBe('string');
    expect(result).not.toBeNull();
    expect(result).not.toBeUndefined();
  });
});

// ===========================================================================
// E. Rollback safety — default is off; toggle state unchanged by calls
// ===========================================================================

describe('E: rollback safety — toggle defaults to off; state not mutated by calls', () => {
  it('E1. PROMPT_ASSEMBLY_DEFAULT is false — toggle is off by default', () => {
    expect(PROMPT_ASSEMBLY_DEFAULT).toBe(false);
  });

  it('E2. readSideChatToggle returns false without any explicit set call', () => {
    // Cold-start state — no setPromptAssemblyEnabled call has occurred
    expect(readSideChatToggle()).toBe(false);
  });

  it('E3. buildSideChatInstructions uses the legacy path by default (no set call needed)', () => {
    // By default, toggle is off — legacy path is taken automatically
    const result = buildSideChatInstructions(
      { toggleEnabled: isPromptAssemblyEnabled() } // reads the actual default
    );
    // Since default is false, SIDE_CHAT_SURFACE_PROMPT must be in the output
    expect(result).toContain(SIDE_CHAT_SURFACE_PROMPT);
  });

  it('E4. calling buildSideChatInstructions does NOT change the toggle state', () => {
    const before = isPromptAssemblyEnabled();
    buildSideChatInstructions(OFF_MINIMAL, mockAssembler);
    const after = isPromptAssemblyEnabled();
    expect(after).toBe(before);
  });

  it('E5. calling buildSideChatInstructions 10 times does NOT change the toggle state', () => {
    const before = isPromptAssemblyEnabled();
    for (let i = 0; i < 10; i++) {
      buildSideChatInstructions(OFF_MINIMAL, mockAssembler);
    }
    expect(isPromptAssemblyEnabled()).toBe(before);
  });

  it('E6. buildSideChatInstructions does not throw when toggle is off', () => {
    expect(() => buildSideChatInstructions(OFF_FULL, mockAssembler)).not.toThrow();
  });

  it('E7. toggle-off path is entered without needing setPromptAssemblyEnabled(false)', () => {
    // The default state alone should produce the legacy result
    resetPromptAssembly(); // Ensure we are at the default
    const result = buildSideChatInstructions(OFF_MINIMAL, mockAssembler);
    // Assembler not called confirms the legacy path ran
    expect(mockAssembler).not.toHaveBeenCalled();
    expect(result).toBe(SIDE_CHAT_SURFACE_PROMPT);
  });

  it('E8. v1.0-equivalent output is preserved after reset from toggle-on state', () => {
    // Set on, then reset — should fall back to default (off) behavior
    setPromptAssemblyEnabled(true);
    resetPromptAssembly();
    // Now back to default — legacy path
    const result = buildSideChatInstructions(OFF_MINIMAL, mockAssembler);
    expect(result).toBe(SIDE_CHAT_SURFACE_PROMPT);
    expect(mockAssembler).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// F. Edge cases — empty, undefined, whitespace, Korean inputs
// ===========================================================================

describe('F: edge cases — empty, undefined, whitespace, Korean', () => {
  it('F1. toggle-off with undefined qualityDirectiveStr does not throw', () => {
    expect(() =>
      buildSideChatInstructions(
        { toggleEnabled: false, qualityDirectiveStr: undefined },
        mockAssembler,
      ),
    ).not.toThrow();
  });

  it('F2. toggle-off with undefined qualityDirectiveStr returns SIDE_CHAT_SURFACE_PROMPT', () => {
    const result = buildSideChatInstructions(
      { toggleEnabled: false, qualityDirectiveStr: undefined },
      mockAssembler,
    );
    expect(result).toBe(SIDE_CHAT_SURFACE_PROMPT);
  });

  it('F3. toggle-off with all undefined optional fields returns SIDE_CHAT_SURFACE_PROMPT', () => {
    const result = buildSideChatInstructions(
      {
        toggleEnabled:      false,
        systemlawContent:   undefined,
        ownerContent:       undefined,
        qualityDirectiveStr: undefined,
        documentText:       undefined,
      },
      mockAssembler,
    );
    expect(result).toBe(SIDE_CHAT_SURFACE_PROMPT);
  });

  it('F4. toggle-off with all empty string fields returns SIDE_CHAT_SURFACE_PROMPT', () => {
    const result = buildSideChatInstructions(
      {
        toggleEnabled:      false,
        systemlawContent:   '',
        ownerContent:       '',
        qualityDirectiveStr: '',
        documentText:       '',
      },
      mockAssembler,
    );
    expect(result).toBe(SIDE_CHAT_SURFACE_PROMPT);
  });

  it('F5. Korean quality directive is preserved in legacy path', () => {
    const q = '초등학교 수준으로 작성하세요.';
    const result = buildSideChatInstructions(
      { toggleEnabled: false, qualityDirectiveStr: q },
      mockAssembler,
    );
    expect(result).toContain(q);
    expect(result).toContain(SIDE_CHAT_SURFACE_PROMPT);
  });

  it('F6. Korean quality directive format: surface + \\n\\n + Korean quality', () => {
    const q = '전문적인 수준으로 작성하세요.';
    const result = buildSideChatInstructions(
      { toggleEnabled: false, qualityDirectiveStr: q },
      mockAssembler,
    );
    expect(result).toBe(`${SIDE_CHAT_SURFACE_PROMPT}\n\n${q}`);
  });

  it('F7. Korean systemlawContent is NOT injected into toggle-off output', () => {
    const koreanLaw = '# AI 행동 규칙\n항상 도움이 되어야 합니다.';
    const result = buildSideChatInstructions(
      { toggleEnabled: false, systemlawContent: koreanLaw },
      mockAssembler,
    );
    expect(result).not.toContain('AI 행동 규칙');
    expect(result).not.toContain('항상 도움이 되어야 합니다.');
  });

  it('F8. Korean ownerContent is NOT injected into toggle-off output', () => {
    const koreanOwner = '# 작성자 소개\n이름: 홍길동\n역할: 시니어 작가';
    const result = buildSideChatInstructions(
      { toggleEnabled: false, ownerContent: koreanOwner },
      mockAssembler,
    );
    expect(result).not.toContain('작성자 소개');
    expect(result).not.toContain('홍길동');
  });

  it('F9. tab character in quality directive is preserved as-is', () => {
    const q = 'Write\tsimply.';
    const result = buildSideChatInstructions(
      { toggleEnabled: false, qualityDirectiveStr: q },
      mockAssembler,
    );
    expect(result).toContain(q);
  });

  it('F10. very long systemlawContent and ownerContent: neither appears in output', () => {
    const longSystemlaw = 'LONG_SYSTEMLAW_'.repeat(200);
    const longOwner     = 'LONG_OWNER_'.repeat(200);
    const result = buildSideChatInstructions(
      {
        toggleEnabled:    false,
        systemlawContent: longSystemlaw,
        ownerContent:     longOwner,
      },
      mockAssembler,
    );
    expect(result).not.toContain('LONG_SYSTEMLAW_');
    expect(result).not.toContain('LONG_OWNER_');
    expect(result).toBe(SIDE_CHAT_SURFACE_PROMPT);
  });
});

// ===========================================================================
// G. Isolation from toggle-on path — toggle-off is independent of toggle-on
// ===========================================================================

describe('G: isolation from toggle-on — toggle-off path is independent', () => {
  it('G1. toggle-off result differs from toggle-on result (assembler produces different output)', () => {
    const onResult = buildSideChatInstructions(
      { toggleEnabled: true, systemlawContent: 'LAW', ownerContent: 'OWNER' },
      mockAssembler,
    );
    const offResult = buildSideChatInstructions(
      { toggleEnabled: false, systemlawContent: 'LAW', ownerContent: 'OWNER' },
      mockAssembler,
    );
    // Toggle-on used the assembler (ASSEMBLER_SENTINEL returned)
    expect(onResult).toBe(ASSEMBLER_SENTINEL);
    // Toggle-off used the legacy path (assembler sentinel NOT present)
    expect(offResult).not.toBe(ASSEMBLER_SENTINEL);
  });

  it('G2. toggle-off result does NOT contain ASSEMBLER_SENTINEL (assembler never ran)', () => {
    const result = buildSideChatInstructions(OFF_FULL, mockAssembler);
    expect(result).not.toContain(ASSEMBLER_SENTINEL);
  });

  it('G3. interleaved calls: off then on calls assembler exactly once', () => {
    buildSideChatInstructions(OFF_MINIMAL, mockAssembler);     // off — no call
    buildSideChatInstructions({ toggleEnabled: true }, mockAssembler); // on — 1 call
    expect(mockAssembler).toHaveBeenCalledTimes(1);
  });

  it('G4. interleaved calls: on then off calls assembler exactly once', () => {
    buildSideChatInstructions({ toggleEnabled: true }, mockAssembler); // on — 1 call
    buildSideChatInstructions(OFF_MINIMAL, mockAssembler);     // off — no new call
    expect(mockAssembler).toHaveBeenCalledTimes(1);
  });

  it('G5. toggle-off result is byte-equal regardless of what the assembler would return', () => {
    // Even if the assembler mock is configured to return different values,
    // the toggle-off result must always be the same legacy string.
    mockAssembler.mockReturnValue('DIFFERENT_ASSEMBLER_VALUE');
    const result1 = buildSideChatInstructions(OFF_MINIMAL, mockAssembler);

    mockAssembler.mockReturnValue('ANOTHER_DIFFERENT_VALUE');
    const result2 = buildSideChatInstructions(OFF_MINIMAL, mockAssembler);

    expect(result1).toBe(SIDE_CHAT_SURFACE_PROMPT);
    expect(result2).toBe(SIDE_CHAT_SURFACE_PROMPT);
    expect(result1).toBe(result2);
  });

  it('G6. toggle-off result never contains Block AI sentinel phrases', () => {
    const BLOCK_AI_SENTINEL_1 = 'EXACTLY 3 alternative rewrites';
    const BLOCK_AI_SENTINEL_2 = 'focused text-rewriting assistant';
    const result = buildSideChatInstructions(OFF_FULL, mockAssembler);
    expect(result).not.toContain(BLOCK_AI_SENTINEL_1);
    expect(result).not.toContain(BLOCK_AI_SENTINEL_2);
  });

  it('G7. toggle-off result contains "editorial consultant" (Side Chat v1.0 identity)', () => {
    const result = buildSideChatInstructions(OFF_MINIMAL, mockAssembler);
    expect(result).toContain('editorial consultant');
  });

  it('G8. toggle-off result contains "Markdown editor" (Side Chat v1.0 surface framing)', () => {
    const result = buildSideChatInstructions(OFF_MINIMAL, mockAssembler);
    expect(result).toContain('Markdown editor');
  });
});
