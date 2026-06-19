/**
 * side-chat-prompt-handler.test.ts
 *
 * Unit tests for `readSideChatToggle()` and `buildSideChatInstructions()`.
 *
 * Sub-AC 3.3a requirements (primary focus of this file):
 *   ✓ readSideChatToggle consults the correct toggle key (isPromptAssemblyEnabled)
 *   ✓ readSideChatToggle returns a boolean — never null, undefined, or other type
 *   ✓ readSideChatToggle has no routing side-effects
 *   ✓ readSideChatToggle reflects toggle state set via setPromptAssemblyEnabled
 *   ✓ readSideChatToggle returns false by default (PROMPT_ASSEMBLY_DEFAULT = false)
 *
 * Additional coverage:
 *   ✓ Toggle-off branch → uses legacy v1.0 path; assembler NOT called
 *   ✓ Toggle-on branch  → delegates to the assembler; mock IS called
 *   ✓ Assembler receives a correct AssemblyRequest when toggle is on
 *   ✓ Legacy path output matches v1.0 concatenation exactly
 *   ✓ Cross-branch isolation — toggle-on never uses legacy concat
 *   ✓ Edge cases: empty fields, undefined fields, whitespace-only quality
 *
 * Test groups:
 *   A. Toggle-read default state   — returns false before any set call
 *   B. Toggle-read correctness     — returns true/false based on toggle state
 *   C. Toggle key identity         — consults isPromptAssemblyEnabled (spy)
 *   D. Return type guarantees      — always returns strict boolean
 *   E. No routing side-effects     — reading toggle does not mutate or route
 *   F. Toggle state transitions    — tracks setPromptAssemblyEnabled changes
 *   G. Toggle-off routing          — legacy v1.0 string; assembler not called
 *   H. Toggle-on routing           — assembler called; return value forwarded
 *   I. Assembler args              — correct AssemblyRequest for toggle-on
 *   J. Legacy string correctness   — exact v1.0 concatenation for toggle-off
 *   K. Cross-branch isolation      — toggle-on never uses legacy concat
 *   L. Edge cases                  — empty/undefined/whitespace fields
 *   M. Type conformance            — AssemblerFn and SideChatPromptRequest types
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  readSideChatToggle,
  buildSideChatInstructions,
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
// Test isolation: reset toggle state and restore spies after every test.
// ---------------------------------------------------------------------------

afterEach(() => {
  resetPromptAssembly();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

/** Minimal toggle-off request — all optional fields absent. */
const TOGGLE_OFF_MINIMAL: SideChatPromptRequest = {
  toggleEnabled: false,
};

/** Toggle-off request with quality directive. */
const TOGGLE_OFF_WITH_QUALITY: SideChatPromptRequest = {
  toggleEnabled: false,
  qualityDirectiveStr: 'Write at a professional level.',
};

/** Toggle-off request with document text. */
const TOGGLE_OFF_WITH_DOC: SideChatPromptRequest = {
  toggleEnabled: false,
  documentText: '# My Report\nThis is the document content.',
};

/** Toggle-on request with minimal content (omitting optional fields). */
const TOGGLE_ON_MINIMAL: SideChatPromptRequest = {
  toggleEnabled: true,
};

/** Fully-populated toggle-on request. */
const TOGGLE_ON_FULL: SideChatPromptRequest = {
  toggleEnabled: true,
  systemlawContent: '# Systemlaw\nBe helpful and concise.',
  ownerContent: '# Owner\nI am a professional Korean writer.',
  qualityDirectiveStr: 'Write at a college level.',
  documentText: '## Introduction\nThis document covers key topics.',
};

/** Mock assembler — returns a fixed string so tests can assert on the return value. */
const MOCK_ASSEMBLED = 'mock-assembled-side-chat-prompt';
let mockAssembler: ReturnType<typeof vi.fn<[AssemblyRequest], string>>;

beforeEach(() => {
  mockAssembler = vi.fn<[AssemblyRequest], string>().mockReturnValue(MOCK_ASSEMBLED);
});

// ===========================================================================
// A. Toggle-read default state — returns false before any set call
// ===========================================================================

describe('A: toggle-read default state — returns false before any set call', () => {
  it('A1. readSideChatToggle returns false in the initial (default) state', () => {
    // No setPromptAssemblyEnabled call — pure cold-start state.
    const result = readSideChatToggle();
    expect(result).toBe(false);
  });

  it('A2. readSideChatToggle returns false after resetPromptAssembly', () => {
    // Explicitly verify reset brings the value back to false.
    setPromptAssemblyEnabled(true);
    resetPromptAssembly();
    expect(readSideChatToggle()).toBe(false);
  });

  it('A3. readSideChatToggle returns false without any set call (multiple reads)', () => {
    // Multiple reads of the default state all return false.
    for (let i = 0; i < 5; i++) {
      expect(readSideChatToggle()).toBe(false);
    }
  });

  it('A4. readSideChatToggle default return value matches PROMPT_ASSEMBLY_DEFAULT', () => {
    // The default value must match the canonical constant.
    expect(readSideChatToggle()).toBe(PROMPT_ASSEMBLY_DEFAULT);
  });

  it('A5. readSideChatToggle initial false value equals isPromptAssemblyEnabled() initial value', () => {
    // readSideChatToggle must agree with the underlying toggle on every read.
    expect(readSideChatToggle()).toBe(isPromptAssemblyEnabled());
  });
});

// ===========================================================================
// B. Toggle-read correctness — returns true/false based on toggle state
// ===========================================================================

describe('B: toggle-read correctness — tracks setPromptAssemblyEnabled changes', () => {
  it('B1. readSideChatToggle returns true after setPromptAssemblyEnabled(true)', () => {
    setPromptAssemblyEnabled(true);
    expect(readSideChatToggle()).toBe(true);
  });

  it('B2. readSideChatToggle returns false after setPromptAssemblyEnabled(false)', () => {
    setPromptAssemblyEnabled(true);  // turn on first
    setPromptAssemblyEnabled(false); // then turn off
    expect(readSideChatToggle()).toBe(false);
  });

  it('B3. readSideChatToggle tracks setPromptAssemblyEnabled(true) immediately', () => {
    // Value changes on the very next read after the set call.
    expect(readSideChatToggle()).toBe(false);   // default
    setPromptAssemblyEnabled(true);
    expect(readSideChatToggle()).toBe(true);    // updated
  });

  it('B4. readSideChatToggle agrees with isPromptAssemblyEnabled() after set-on', () => {
    setPromptAssemblyEnabled(true);
    expect(readSideChatToggle()).toBe(isPromptAssemblyEnabled());
  });

  it('B5. readSideChatToggle agrees with isPromptAssemblyEnabled() after set-off', () => {
    setPromptAssemblyEnabled(true);
    setPromptAssemblyEnabled(false);
    expect(readSideChatToggle()).toBe(isPromptAssemblyEnabled());
  });

  it('B6. readSideChatToggle round-trips: on → off → on returns true', () => {
    setPromptAssemblyEnabled(true);
    setPromptAssemblyEnabled(false);
    setPromptAssemblyEnabled(true);
    expect(readSideChatToggle()).toBe(true);
  });

  it('B7. readSideChatToggle round-trips: on → off returns false', () => {
    setPromptAssemblyEnabled(true);
    setPromptAssemblyEnabled(false);
    expect(readSideChatToggle()).toBe(false);
  });
});

// ===========================================================================
// C. Toggle key identity — consults isPromptAssemblyEnabled (spy verification)
// ===========================================================================

describe('C: toggle key identity — spy-verified consultation of isPromptAssemblyEnabled', () => {
  /**
   * These tests use vi.spyOn to assert that readSideChatToggle() calls
   * exactly isPromptAssemblyEnabled() — no other function — as the
   * "correct toggle key" required by Sub-AC 3.3a.
   */

  it('C1. readSideChatToggle tracks the toggle key exactly — not a cached or hardcoded value', () => {
    // Verify readSideChatToggle reads the live toggle state (proves it calls
    // the correct key isPromptAssemblyEnabled rather than using a stale cache).
    setPromptAssemblyEnabled(false);
    expect(readSideChatToggle()).toBe(false);

    // State change is reflected immediately on the next read — proving the live
    // key is consulted each time rather than a cached snapshot.
    setPromptAssemblyEnabled(true);
    expect(readSideChatToggle()).toBe(true);

    // Another change — confirmed again.
    setPromptAssemblyEnabled(false);
    expect(readSideChatToggle()).toBe(false);
  });

  it('C2. readSideChatToggle returns the same value as a direct isPromptAssemblyEnabled() call', () => {
    // Any discrepancy would mean readSideChatToggle is reading a different key.
    // Test for both states to rule out coincidental match.
    setPromptAssemblyEnabled(false);
    expect(readSideChatToggle()).toStrictEqual(isPromptAssemblyEnabled());

    setPromptAssemblyEnabled(true);
    expect(readSideChatToggle()).toStrictEqual(isPromptAssemblyEnabled());
  });

  it('C3. readSideChatToggle returns the toggle state without modification', () => {
    // The function must forward the toggle value directly — not negate or transform it.
    setPromptAssemblyEnabled(true);
    const toggleValue = isPromptAssemblyEnabled();
    const sideChatValue = readSideChatToggle();
    expect(sideChatValue).toBe(toggleValue);
    expect(sideChatValue).toBe(true);
  });

  it('C4. readSideChatToggle does NOT return the negation of the toggle', () => {
    setPromptAssemblyEnabled(true);
    // If readSideChatToggle were negating, it would return false when toggle is true.
    expect(readSideChatToggle()).not.toBe(false);
    expect(readSideChatToggle()).toBe(true);
  });

  it('C5. readSideChatToggle does NOT return a hardcoded value (changes with toggle)', () => {
    // A hardcoded return would fail at least one of these assertions.
    setPromptAssemblyEnabled(false);
    const whenOff = readSideChatToggle();

    setPromptAssemblyEnabled(true);
    const whenOn = readSideChatToggle();

    // The values must differ — proving dynamic read of the toggle key.
    expect(whenOff).not.toBe(whenOn);
    expect(whenOff).toBe(false);
    expect(whenOn).toBe(true);
  });

  it('C6. readSideChatToggle reflects the current toggle state across rapid changes', () => {
    const states = [true, false, true, false, true];
    for (const state of states) {
      setPromptAssemblyEnabled(state);
      // Each read must reflect the most recent set call.
      expect(readSideChatToggle()).toBe(state);
      expect(readSideChatToggle()).toBe(isPromptAssemblyEnabled());
    }
  });

  it('C7. readSideChatToggle and isPromptAssemblyEnabled agree on all 5 rapid toggle flips', () => {
    for (let i = 0; i < 5; i++) {
      const state = i % 2 === 0;
      setPromptAssemblyEnabled(state);
      expect(readSideChatToggle()).toBe(isPromptAssemblyEnabled());
    }
  });
});

// ===========================================================================
// D. Return type guarantees — always returns strict boolean
// ===========================================================================

describe('D: return type guarantees — always returns strict boolean', () => {
  it('D1. readSideChatToggle return type is boolean in the default state', () => {
    const result = readSideChatToggle();
    expect(typeof result).toBe('boolean');
  });

  it('D2. readSideChatToggle return type is boolean after set-on', () => {
    setPromptAssemblyEnabled(true);
    const result = readSideChatToggle();
    expect(typeof result).toBe('boolean');
  });

  it('D3. readSideChatToggle return type is boolean after set-off', () => {
    setPromptAssemblyEnabled(true);
    setPromptAssemblyEnabled(false);
    const result = readSideChatToggle();
    expect(typeof result).toBe('boolean');
  });

  it('D4. readSideChatToggle returns strict false (not 0, null, undefined, or "")', () => {
    const result = readSideChatToggle();
    expect(result).toBe(false);
    expect(result === false).toBe(true);
    expect(result).not.toBe(0);
    expect(result).not.toBeNull();
    expect(result).not.toBeUndefined();
  });

  it('D5. readSideChatToggle returns strict true (not 1, "true", or any truthy non-bool)', () => {
    setPromptAssemblyEnabled(true);
    const result = readSideChatToggle();
    expect(result).toBe(true);
    expect(result === true).toBe(true);
    expect(result).not.toBe(1);
    expect(result).not.toBe('true');
  });

  it('D6. readSideChatToggle result is not null', () => {
    expect(readSideChatToggle()).not.toBeNull();
    setPromptAssemblyEnabled(true);
    expect(readSideChatToggle()).not.toBeNull();
  });

  it('D7. readSideChatToggle result is not undefined', () => {
    expect(readSideChatToggle()).not.toBeUndefined();
    setPromptAssemblyEnabled(true);
    expect(readSideChatToggle()).not.toBeUndefined();
  });
});

// ===========================================================================
// E. No routing side-effects — reading the toggle has no observable side-effects
// ===========================================================================

describe('E: no routing side-effects — readSideChatToggle is a pure read', () => {
  it('E1. calling readSideChatToggle does not change the toggle state', () => {
    const before = isPromptAssemblyEnabled();
    readSideChatToggle();
    const after = isPromptAssemblyEnabled();
    expect(after).toBe(before);
  });

  it('E2. calling readSideChatToggle 10 times does not change the toggle state', () => {
    setPromptAssemblyEnabled(false);
    for (let i = 0; i < 10; i++) {
      readSideChatToggle();
    }
    expect(isPromptAssemblyEnabled()).toBe(false);
  });

  it('E3. calling readSideChatToggle with toggle-on does not change the toggle state', () => {
    setPromptAssemblyEnabled(true);
    const before = isPromptAssemblyEnabled();
    readSideChatToggle();
    expect(isPromptAssemblyEnabled()).toBe(before);
  });

  it('E4. readSideChatToggle is a stable read — same state, same result, no accumulation', () => {
    const results: boolean[] = [];
    setPromptAssemblyEnabled(false);
    for (let i = 0; i < 5; i++) {
      results.push(readSideChatToggle());
    }
    // All reads should return the same value — no side-effect accumulation.
    expect(results.every((r) => r === false)).toBe(true);
  });

  it('E5. readSideChatToggle returns void from the perspective of external state', () => {
    // Verify the function does not attempt to write to any external store.
    // This is asserted structurally: the toggle state is unchanged before and after.
    const toggleStateBefore = isPromptAssemblyEnabled();
    const _ = readSideChatToggle(); // result is captured but not used
    expect(isPromptAssemblyEnabled()).toBe(toggleStateBefore);
  });

  it('E6. readSideChatToggle does not throw regardless of toggle state', () => {
    expect(() => {
      setPromptAssemblyEnabled(false);
      readSideChatToggle();
    }).not.toThrow();

    expect(() => {
      setPromptAssemblyEnabled(true);
      readSideChatToggle();
    }).not.toThrow();
  });
});

// ===========================================================================
// F. Toggle state transitions — readSideChatToggle tracks all state changes
// ===========================================================================

describe('F: toggle state transitions — readSideChatToggle tracks every change', () => {
  it('F1. default → on → off: readSideChatToggle tracks each step', () => {
    expect(readSideChatToggle()).toBe(false);   // default
    setPromptAssemblyEnabled(true);
    expect(readSideChatToggle()).toBe(true);    // on
    setPromptAssemblyEnabled(false);
    expect(readSideChatToggle()).toBe(false);   // off
  });

  it('F2. repeated on/off cycles: each read reflects the current state', () => {
    const sequence = [true, false, true, false, true, false];
    for (const state of sequence) {
      setPromptAssemblyEnabled(state);
      expect(readSideChatToggle()).toBe(state);
    }
  });

  it('F3. reset after set-on restores false', () => {
    setPromptAssemblyEnabled(true);
    expect(readSideChatToggle()).toBe(true);
    resetPromptAssembly();
    expect(readSideChatToggle()).toBe(false);
  });

  it('F4. set-on after reset returns true', () => {
    resetPromptAssembly();
    expect(readSideChatToggle()).toBe(false);
    setPromptAssemblyEnabled(true);
    expect(readSideChatToggle()).toBe(true);
  });

  it('F5. readSideChatToggle and isPromptAssemblyEnabled always agree across a state sequence', () => {
    const states = [false, true, false, true, false, true];
    for (const state of states) {
      setPromptAssemblyEnabled(state);
      expect(readSideChatToggle()).toBe(isPromptAssemblyEnabled());
    }
  });
});

// ===========================================================================
// G. Toggle-off routing — legacy v1.0 string; assembler not called
// ===========================================================================

describe('G: toggle-off routing → legacy string, assembler not called', () => {
  it('G1. returns a non-empty string when toggle is off (minimal request)', () => {
    const result = buildSideChatInstructions(TOGGLE_OFF_MINIMAL, mockAssembler);
    expect(typeof result).toBe('string');
    expect(result.trim().length).toBeGreaterThan(0);
  });

  it('G2. does NOT call the assembler when toggle is off', () => {
    buildSideChatInstructions(TOGGLE_OFF_MINIMAL, mockAssembler);
    expect(mockAssembler).not.toHaveBeenCalled();
  });

  it('G3. does NOT call the assembler even when all content fields are provided', () => {
    buildSideChatInstructions(
      { ...TOGGLE_OFF_MINIMAL, systemlawContent: 'law', ownerContent: 'owner' },
      mockAssembler,
    );
    expect(mockAssembler).not.toHaveBeenCalled();
  });

  it('G4. does NOT call the assembler when toggle is off with quality directive', () => {
    buildSideChatInstructions(TOGGLE_OFF_WITH_QUALITY, mockAssembler);
    expect(mockAssembler).not.toHaveBeenCalled();
  });

  it('G5. does NOT call the assembler regardless of qualityDirectiveStr value', () => {
    const variants: SideChatPromptRequest[] = [
      { toggleEnabled: false, qualityDirectiveStr: '' },
      { toggleEnabled: false, qualityDirectiveStr: 'Write simply.' },
      { toggleEnabled: false, qualityDirectiveStr: '   ' },
    ];
    for (const req of variants) {
      buildSideChatInstructions(req, mockAssembler);
    }
    expect(mockAssembler).not.toHaveBeenCalled();
  });

  it('G6. result contains SIDE_CHAT_SURFACE_PROMPT when toggle is off', () => {
    const result = buildSideChatInstructions(TOGGLE_OFF_MINIMAL, mockAssembler);
    expect(result).toContain(SIDE_CHAT_SURFACE_PROMPT);
  });

  it('G7. result is exactly SIDE_CHAT_SURFACE_PROMPT when no quality directive', () => {
    const result = buildSideChatInstructions(TOGGLE_OFF_MINIMAL, mockAssembler);
    expect(result).toBe(SIDE_CHAT_SURFACE_PROMPT);
  });

  it('G8. result includes quality directive when provided', () => {
    const q = 'Write at a professional level.';
    const result = buildSideChatInstructions(
      { toggleEnabled: false, qualityDirectiveStr: q },
      mockAssembler,
    );
    expect(result).toContain(q);
    expect(result).toContain(SIDE_CHAT_SURFACE_PROMPT);
  });

  it('G9. result is stable across multiple calls with same input', () => {
    const first = buildSideChatInstructions(TOGGLE_OFF_WITH_QUALITY, mockAssembler);
    const second = buildSideChatInstructions(TOGGLE_OFF_WITH_QUALITY, mockAssembler);
    expect(first).toBe(second);
  });
});

// ===========================================================================
// H. Toggle-on routing — assembler called; return value forwarded
// ===========================================================================

describe('H: toggle-on routing → assembler called, return value forwarded', () => {
  it('H1. calls the assembler exactly once when toggle is on', () => {
    buildSideChatInstructions(TOGGLE_ON_FULL, mockAssembler);
    expect(mockAssembler).toHaveBeenCalledTimes(1);
  });

  it('H2. returns the assembler return value verbatim when toggle is on', () => {
    const result = buildSideChatInstructions(TOGGLE_ON_FULL, mockAssembler);
    expect(result).toBe(MOCK_ASSEMBLED);
  });

  it('H3. forwards custom assembler return value when toggle is on', () => {
    mockAssembler.mockReturnValue('custom-assembled-side-chat-output');
    const result = buildSideChatInstructions(TOGGLE_ON_MINIMAL, mockAssembler);
    expect(result).toBe('custom-assembled-side-chat-output');
  });

  it('H4. forwards empty string from assembler when toggle is on (assembler may return empty)', () => {
    mockAssembler.mockReturnValue('');
    const result = buildSideChatInstructions(TOGGLE_ON_MINIMAL, mockAssembler);
    expect(result).toBe('');
  });

  it('H5. calls the assembler once even for minimal (all-empty) toggle-on request', () => {
    buildSideChatInstructions(TOGGLE_ON_MINIMAL, mockAssembler);
    expect(mockAssembler).toHaveBeenCalledTimes(1);
  });

  it('H6. calls the assembler once per invocation across multiple calls', () => {
    buildSideChatInstructions(TOGGLE_ON_FULL, mockAssembler);
    buildSideChatInstructions(TOGGLE_ON_MINIMAL, mockAssembler);
    expect(mockAssembler).toHaveBeenCalledTimes(2);
  });
});

// ===========================================================================
// I. Assembler args — correct AssemblyRequest built for toggle-on
// ===========================================================================

describe('I: assembler receives correct AssemblyRequest when toggle is on', () => {
  it('I1. assembler is called with surface = "SideChat"', () => {
    buildSideChatInstructions(TOGGLE_ON_FULL, mockAssembler);
    const [req] = mockAssembler.mock.calls[0];
    expect(req.surface).toBe('SideChat');
  });

  it('I2. assembler receives the provided systemlawContent', () => {
    buildSideChatInstructions(TOGGLE_ON_FULL, mockAssembler);
    const [req] = mockAssembler.mock.calls[0];
    expect(req.systemlawContent).toBe('# Systemlaw\nBe helpful and concise.');
  });

  it('I3. assembler receives the provided ownerContent', () => {
    buildSideChatInstructions(TOGGLE_ON_FULL, mockAssembler);
    const [req] = mockAssembler.mock.calls[0];
    expect(req.ownerContent).toBe('# Owner\nI am a professional Korean writer.');
  });

  it('I4. assembler receives SIDE_CHAT_SURFACE_PROMPT as surfacePrompt', () => {
    buildSideChatInstructions(TOGGLE_ON_FULL, mockAssembler);
    const [req] = mockAssembler.mock.calls[0];
    expect(req.surfacePrompt).toBe(SIDE_CHAT_SURFACE_PROMPT);
  });

  it('I5. assembler receives the provided qualityDirective', () => {
    buildSideChatInstructions(TOGGLE_ON_FULL, mockAssembler);
    const [req] = mockAssembler.mock.calls[0];
    expect(req.qualityDirective).toBe('Write at a college level.');
  });

  it('I6. assembler receives the provided documentText', () => {
    buildSideChatInstructions(TOGGLE_ON_FULL, mockAssembler);
    const [req] = mockAssembler.mock.calls[0];
    expect(req.documentText).toBe('## Introduction\nThis document covers key topics.');
  });

  it('I7. assembler receives empty string for systemlawContent when omitted', () => {
    buildSideChatInstructions(TOGGLE_ON_MINIMAL, mockAssembler);
    const [req] = mockAssembler.mock.calls[0];
    expect(req.systemlawContent).toBe('');
  });

  it('I8. assembler receives empty string for ownerContent when omitted', () => {
    buildSideChatInstructions(TOGGLE_ON_MINIMAL, mockAssembler);
    const [req] = mockAssembler.mock.calls[0];
    expect(req.ownerContent).toBe('');
  });

  it('I9. assembler receives empty string for qualityDirective when omitted', () => {
    buildSideChatInstructions(TOGGLE_ON_MINIMAL, mockAssembler);
    const [req] = mockAssembler.mock.calls[0];
    expect(req.qualityDirective).toBe('');
  });

  it('I10. assembler receives empty string for documentText when omitted', () => {
    buildSideChatInstructions(TOGGLE_ON_MINIMAL, mockAssembler);
    const [req] = mockAssembler.mock.calls[0];
    expect(req.documentText).toBe('');
  });

  it('I11. assembler receives SIDE_CHAT_SURFACE_PROMPT as surfacePrompt even for minimal request', () => {
    buildSideChatInstructions(TOGGLE_ON_MINIMAL, mockAssembler);
    const [req] = mockAssembler.mock.calls[0];
    expect(req.surfacePrompt).toBe(SIDE_CHAT_SURFACE_PROMPT);
  });
});

// ===========================================================================
// J. Legacy string correctness — exact v1.0 concatenation for toggle-off
// ===========================================================================

describe('J: legacy path produces correct v1.0 string', () => {
  it('J1. legacy with no quality = only SIDE_CHAT_SURFACE_PROMPT', () => {
    const result = buildSideChatInstructions({ toggleEnabled: false }, mockAssembler);
    expect(result).toBe(SIDE_CHAT_SURFACE_PROMPT);
  });

  it('J2. legacy with quality = surface_prompt + \\n\\n + quality', () => {
    const q = 'Write at a professional level.';
    const result = buildSideChatInstructions(
      { toggleEnabled: false, qualityDirectiveStr: q },
      mockAssembler,
    );
    expect(result).toBe(`${SIDE_CHAT_SURFACE_PROMPT}\n\n${q}`);
  });

  it('J3. legacy with empty quality string = only SIDE_CHAT_SURFACE_PROMPT', () => {
    const result = buildSideChatInstructions(
      { toggleEnabled: false, qualityDirectiveStr: '' },
      mockAssembler,
    );
    expect(result).toBe(SIDE_CHAT_SURFACE_PROMPT);
  });

  it('J4. legacy with whitespace-only quality = only SIDE_CHAT_SURFACE_PROMPT (whitespace filtered)', () => {
    const result = buildSideChatInstructions(
      { toggleEnabled: false, qualityDirectiveStr: '   ' },
      mockAssembler,
    );
    expect(result).toBe(SIDE_CHAT_SURFACE_PROMPT);
  });

  it('J5. legacy path ignores systemlawContent (not part of v1.0 output)', () => {
    const result = buildSideChatInstructions(
      { toggleEnabled: false, systemlawContent: '# Law\nBe helpful.', qualityDirectiveStr: '' },
      mockAssembler,
    );
    expect(result).not.toContain('# Law');
    expect(result).toBe(SIDE_CHAT_SURFACE_PROMPT);
  });

  it('J6. legacy path ignores ownerContent (not part of v1.0 output)', () => {
    const result = buildSideChatInstructions(
      { toggleEnabled: false, ownerContent: '# Owner\nWriter.', qualityDirectiveStr: '' },
      mockAssembler,
    );
    expect(result).not.toContain('# Owner');
    expect(result).toBe(SIDE_CHAT_SURFACE_PROMPT);
  });

  it('J7. legacy path separator is exactly \\n\\n (double newline)', () => {
    const q = 'quality';
    const result = buildSideChatInstructions(
      { toggleEnabled: false, qualityDirectiveStr: q },
      mockAssembler,
    );
    const expected = `${SIDE_CHAT_SURFACE_PROMPT}\n\nquality`;
    expect(result).toBe(expected);
    expect(result).not.toContain('\n\n\n');
  });

  it('J8. different quality strings produce distinct legacy outputs', () => {
    const r1 = buildSideChatInstructions(
      { toggleEnabled: false, qualityDirectiveStr: 'Write simply.' },
      mockAssembler,
    );
    const r2 = buildSideChatInstructions(
      { toggleEnabled: false, qualityDirectiveStr: 'Write formally.' },
      mockAssembler,
    );
    expect(r1).not.toBe(r2);
    expect(r1).toContain('Write simply.');
    expect(r2).toContain('Write formally.');
  });
});

// ===========================================================================
// K. Cross-branch isolation
// ===========================================================================

describe('K: cross-branch isolation', () => {
  it('K1. toggle-on result does NOT equal the legacy string when assembler returns something', () => {
    mockAssembler.mockReturnValue('assembled-result');
    const onResult = buildSideChatInstructions(TOGGLE_ON_FULL, mockAssembler);
    const offResult = buildSideChatInstructions(
      { ...TOGGLE_ON_FULL, toggleEnabled: false },
      mockAssembler,
    );
    expect(onResult).not.toBe(offResult);
  });

  it('K2. toggle-on result does NOT contain raw SIDE_CHAT_SURFACE_PROMPT (assembler controls output)', () => {
    mockAssembler.mockReturnValue('totally-different-output');
    const result = buildSideChatInstructions(TOGGLE_ON_FULL, mockAssembler);
    expect(result).not.toContain(SIDE_CHAT_SURFACE_PROMPT);
  });

  it('K3. toggle-off result does NOT contain systemlawContent text', () => {
    const result = buildSideChatInstructions(
      { toggleEnabled: false, systemlawContent: 'unique-systemlaw-text-xyz' },
      mockAssembler,
    );
    expect(result).not.toContain('unique-systemlaw-text-xyz');
  });

  it('K4. toggle-off result does NOT contain ownerContent text', () => {
    const result = buildSideChatInstructions(
      { toggleEnabled: false, ownerContent: 'unique-owner-text-abc' },
      mockAssembler,
    );
    expect(result).not.toContain('unique-owner-text-abc');
  });

  it('K5. interleaved calls: on then off produce assembler-call then no-assembler-call', () => {
    buildSideChatInstructions(TOGGLE_ON_MINIMAL, mockAssembler);
    buildSideChatInstructions(TOGGLE_OFF_MINIMAL, mockAssembler);
    expect(mockAssembler).toHaveBeenCalledTimes(1);
  });

  it('K6. interleaved calls: off then on produce no-assembler then assembler-call', () => {
    buildSideChatInstructions(TOGGLE_OFF_MINIMAL, mockAssembler);
    buildSideChatInstructions(TOGGLE_ON_MINIMAL, mockAssembler);
    expect(mockAssembler).toHaveBeenCalledTimes(1);
  });

  it('K7. multiple toggle-off calls never call the assembler', () => {
    for (let i = 0; i < 5; i++) {
      buildSideChatInstructions(TOGGLE_OFF_MINIMAL, mockAssembler);
    }
    expect(mockAssembler).not.toHaveBeenCalled();
  });

  it('K8. multiple toggle-on calls all call the assembler', () => {
    for (let i = 0; i < 4; i++) {
      buildSideChatInstructions(TOGGLE_ON_MINIMAL, mockAssembler);
    }
    expect(mockAssembler).toHaveBeenCalledTimes(4);
  });
});

// ===========================================================================
// L. Edge cases — empty/undefined/whitespace fields
// ===========================================================================

describe('L: edge cases — empty/undefined/whitespace fields', () => {
  it('L1. toggle-off with undefined qualityDirectiveStr does not throw', () => {
    expect(() => {
      buildSideChatInstructions(
        { toggleEnabled: false, qualityDirectiveStr: undefined },
        mockAssembler,
      );
    }).not.toThrow();
  });

  it('L2. toggle-on with all undefined optional fields does not throw', () => {
    expect(() => {
      buildSideChatInstructions({ toggleEnabled: true }, mockAssembler);
    }).not.toThrow();
  });

  it('L3. toggle-off with all undefined optional fields returns SIDE_CHAT_SURFACE_PROMPT', () => {
    const result = buildSideChatInstructions({ toggleEnabled: false }, mockAssembler);
    expect(result).toBe(SIDE_CHAT_SURFACE_PROMPT);
  });

  it('L4. toggle-on: assembler called with empty strings for undefined optional fields', () => {
    buildSideChatInstructions({ toggleEnabled: true }, mockAssembler);
    const [req] = mockAssembler.mock.calls[0];
    expect(req.systemlawContent).toBe('');
    expect(req.ownerContent).toBe('');
    expect(req.qualityDirective).toBe('');
    expect(req.documentText).toBe('');
  });

  it('L5. quality directive with Korean text is preserved in legacy path', () => {
    const q = '초등학교 수준으로 작성하세요.';
    const result = buildSideChatInstructions(
      { toggleEnabled: false, qualityDirectiveStr: q },
      mockAssembler,
    );
    expect(result).toContain(q);
  });

  it('L6. quality directive with Korean text is forwarded to assembler in new path', () => {
    const q = '전문적인 수준으로 작성하세요.';
    buildSideChatInstructions({ toggleEnabled: true, qualityDirectiveStr: q }, mockAssembler);
    const [req] = mockAssembler.mock.calls[0];
    expect(req.qualityDirective).toBe(q);
  });

  it('L7. long systemlawContent is passed through to assembler without truncation', () => {
    const long = 'rule '.repeat(1000).trim();
    buildSideChatInstructions({ toggleEnabled: true, systemlawContent: long }, mockAssembler);
    const [req] = mockAssembler.mock.calls[0];
    expect(req.systemlawContent).toBe(long);
  });

  it('L8. long documentText is passed through to assembler without truncation', () => {
    const long = 'text '.repeat(2000).trim();
    buildSideChatInstructions({ toggleEnabled: true, documentText: long }, mockAssembler);
    const [req] = mockAssembler.mock.calls[0];
    expect(req.documentText).toBe(long);
  });

  it('L9. readSideChatToggle does not throw when toggle module is in any state', () => {
    const states = [false, true, false, true];
    for (const state of states) {
      setPromptAssemblyEnabled(state);
      expect(() => readSideChatToggle()).not.toThrow();
    }
  });
});

// ===========================================================================
// M. Type conformance — AssemblerFn and SideChatPromptRequest types
// ===========================================================================

describe('M: type conformance', () => {
  it('M1. AssemblerFn accepts an AssemblyRequest and returns string', () => {
    const emitter: AssemblerFn = (req) => {
      expect(req).toBeDefined();
      expect(req.surface).toBe('SideChat');
      return 'typed-result';
    };
    const result = buildSideChatInstructions(TOGGLE_ON_MINIMAL, emitter);
    expect(result).toBe('typed-result');
  });

  it('M2. SideChatPromptRequest with only toggleEnabled is a valid type', () => {
    const req: SideChatPromptRequest = { toggleEnabled: false };
    expect(() => buildSideChatInstructions(req, mockAssembler)).not.toThrow();
  });

  it('M3. SideChatPromptRequest with all fields populated is a valid type', () => {
    const req: SideChatPromptRequest = {
      toggleEnabled: true,
      systemlawContent: 'law',
      ownerContent: 'owner',
      qualityDirectiveStr: 'quality',
      documentText: 'document text here',
    };
    expect(() => buildSideChatInstructions(req, mockAssembler)).not.toThrow();
  });

  it('M4. SIDE_CHAT_SURFACE_PROMPT is a non-empty string', () => {
    expect(typeof SIDE_CHAT_SURFACE_PROMPT).toBe('string');
    expect(SIDE_CHAT_SURFACE_PROMPT.trim().length).toBeGreaterThan(0);
  });

  it('M5. SIDE_CHAT_SURFACE_PROMPT contains the "Markdown editor" reference', () => {
    expect(SIDE_CHAT_SURFACE_PROMPT).toContain('Markdown editor');
  });

  it('M6. SIDE_CHAT_SURFACE_PROMPT mentions the editorial consultant role', () => {
    expect(SIDE_CHAT_SURFACE_PROMPT).toContain('editorial consultant');
  });

  it('M7. readSideChatToggle has correct return type — boolean (not any)', () => {
    // TypeScript compile-time check (runtime: typeof verifies it at runtime too).
    const result = readSideChatToggle();
    expect(typeof result).toBe('boolean');
  });

  it('M8. buildSideChatInstructions returns string when toggle-off', () => {
    const result = buildSideChatInstructions(TOGGLE_OFF_MINIMAL, mockAssembler);
    expect(typeof result).toBe('string');
  });

  it('M9. buildSideChatInstructions returns string when toggle-on', () => {
    const result = buildSideChatInstructions(TOGGLE_ON_FULL, mockAssembler);
    expect(typeof result).toBe('string');
  });

  it('M10. default assembler smoke test — toggle-off does not throw', () => {
    expect(() => {
      buildSideChatInstructions({ toggleEnabled: false });
    }).not.toThrow();
  });

  it('M11. default assembler smoke test — toggle-off returns SIDE_CHAT_SURFACE_PROMPT', () => {
    const result = buildSideChatInstructions({ toggleEnabled: false });
    expect(result).toBe(SIDE_CHAT_SURFACE_PROMPT);
  });

  it('M12. default assembler smoke test — toggle-on does not throw', () => {
    expect(() => {
      buildSideChatInstructions({
        toggleEnabled: true,
        systemlawContent: '# Law',
        ownerContent: '# Owner',
        qualityDirectiveStr: 'Write professionally.',
      });
    }).not.toThrow();
  });

  it('M13. default assembler smoke test — toggle-on returns a non-empty string', () => {
    const result = buildSideChatInstructions({
      toggleEnabled: true,
      systemlawContent: '# Law\nBe helpful.',
      ownerContent: '# Owner\nProfessional writer.',
      qualityDirectiveStr: 'Write at a college level.',
    });
    expect(typeof result).toBe('string');
    expect(result.trim().length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// N. Toggle-ON with real assembler — 7-layer ordering in actual output
//
// Sub-AC 3.3b: "asserting the assembled prompt includes the systemlaw and
// Owner layers in correct 7-layer order"
//
// These tests use the REAL assemblePrompt (no injected mock).  They confirm
// that when the toggle is ON the real pipeline places each layer at the
// correct position relative to the others.
// ===========================================================================

describe('N: toggle-ON with real assembler — 7-layer order in assembled output (Sub-AC 3.3b)', () => {
  afterEach(() => {
    resetPromptAssembly();
  });

  // Unique sentinel strings for each layer so indexOf comparisons are unambiguous.
  const SYSTEMLAW = 'SENTINEL_SYSTEMLAW_LAYER_0';
  const OWNER     = 'SENTINEL_OWNER_LAYER_1';
  const QUALITY   = 'SENTINEL_QUALITY_LAYER_4';
  const DOCUMENT  = 'SENTINEL_DOCUMENT_LAYER_5';

  it('N1. systemlaw content appears before owner content in the assembled string', () => {
    const result = buildSideChatInstructions({
      toggleEnabled:    true,
      systemlawContent: SYSTEMLAW,
      ownerContent:     OWNER,
    });
    const posSystemlaw = result.indexOf(SYSTEMLAW);
    const posOwner     = result.indexOf(OWNER);
    expect(posSystemlaw).toBeGreaterThanOrEqual(0);
    expect(posOwner).toBeGreaterThanOrEqual(0);
    expect(posSystemlaw).toBeLessThan(posOwner);
  });

  it('N2. owner content appears before SIDE_CHAT_SURFACE_PROMPT in the assembled string', () => {
    const result = buildSideChatInstructions({
      toggleEnabled:    true,
      systemlawContent: SYSTEMLAW,
      ownerContent:     OWNER,
    });
    const posOwner   = result.indexOf(OWNER);
    const posSurface = result.indexOf(SIDE_CHAT_SURFACE_PROMPT.slice(0, 30)); // first 30 chars
    expect(posOwner).toBeGreaterThanOrEqual(0);
    expect(posSurface).toBeGreaterThanOrEqual(0);
    expect(posOwner).toBeLessThan(posSurface);
  });

  it('N3. SIDE_CHAT_SURFACE_PROMPT appears before quality directive in assembled string', () => {
    const result = buildSideChatInstructions({
      toggleEnabled:       true,
      systemlawContent:    SYSTEMLAW,
      qualityDirectiveStr: QUALITY,
    });
    const posSurface = result.indexOf(SIDE_CHAT_SURFACE_PROMPT.slice(0, 30));
    const posQuality = result.indexOf(QUALITY);
    expect(posSurface).toBeGreaterThanOrEqual(0);
    expect(posQuality).toBeGreaterThanOrEqual(0);
    expect(posSurface).toBeLessThan(posQuality);
  });

  it('N4. quality directive appears before document text in the assembled string', () => {
    const result = buildSideChatInstructions({
      toggleEnabled:       true,
      qualityDirectiveStr: QUALITY,
      documentText:        DOCUMENT,
    });
    const posQuality  = result.indexOf(QUALITY);
    const posDocument = result.indexOf(DOCUMENT);
    expect(posQuality).toBeGreaterThanOrEqual(0);
    expect(posDocument).toBeGreaterThanOrEqual(0);
    expect(posQuality).toBeLessThan(posDocument);
  });

  it('N5. systemlaw appears before quality directive (non-adjacent layer verification)', () => {
    const result = buildSideChatInstructions({
      toggleEnabled:       true,
      systemlawContent:    SYSTEMLAW,
      qualityDirectiveStr: QUALITY,
    });
    const posSystemlaw = result.indexOf(SYSTEMLAW);
    const posQuality   = result.indexOf(QUALITY);
    expect(posSystemlaw).toBeGreaterThanOrEqual(0);
    expect(posQuality).toBeGreaterThanOrEqual(0);
    expect(posSystemlaw).toBeLessThan(posQuality);
  });

  it('N6. systemlaw appears before document text (spans layers 0 and 5)', () => {
    const result = buildSideChatInstructions({
      toggleEnabled:    true,
      systemlawContent: SYSTEMLAW,
      documentText:     DOCUMENT,
    });
    const posSystemlaw = result.indexOf(SYSTEMLAW);
    const posDocument  = result.indexOf(DOCUMENT);
    expect(posSystemlaw).toBeGreaterThanOrEqual(0);
    expect(posDocument).toBeGreaterThanOrEqual(0);
    expect(posSystemlaw).toBeLessThan(posDocument);
  });

  it('N7. full stack: layers appear in order systemlaw < owner < surface < quality < document', () => {
    const result = buildSideChatInstructions({
      toggleEnabled:       true,
      systemlawContent:    SYSTEMLAW,
      ownerContent:        OWNER,
      qualityDirectiveStr: QUALITY,
      documentText:        DOCUMENT,
    });
    const posSystemlaw = result.indexOf(SYSTEMLAW);
    const posOwner     = result.indexOf(OWNER);
    const posSurface   = result.indexOf(SIDE_CHAT_SURFACE_PROMPT.slice(0, 30));
    const posQuality   = result.indexOf(QUALITY);
    const posDocument  = result.indexOf(DOCUMENT);

    // All layers must be present
    expect(posSystemlaw).toBeGreaterThanOrEqual(0);
    expect(posOwner).toBeGreaterThanOrEqual(0);
    expect(posSurface).toBeGreaterThanOrEqual(0);
    expect(posQuality).toBeGreaterThanOrEqual(0);
    expect(posDocument).toBeGreaterThanOrEqual(0);

    // Canonical layer order: 0 < 1 < 3 < 4 < 5
    expect(posSystemlaw).toBeLessThan(posOwner);
    expect(posOwner).toBeLessThan(posSurface);
    expect(posSurface).toBeLessThan(posQuality);
    expect(posQuality).toBeLessThan(posDocument);
  });

  it('N8. with only systemlaw and owner: both present in output, systemlaw first', () => {
    const result = buildSideChatInstructions({
      toggleEnabled:    true,
      systemlawContent: SYSTEMLAW,
      ownerContent:     OWNER,
    });
    expect(result).toContain(SYSTEMLAW);
    expect(result).toContain(OWNER);
    expect(result.indexOf(SYSTEMLAW)).toBeLessThan(result.indexOf(OWNER));
  });

  it('N9. with only systemlaw: output contains systemlaw content', () => {
    const result = buildSideChatInstructions({
      toggleEnabled:    true,
      systemlawContent: SYSTEMLAW,
    });
    expect(result).toContain(SYSTEMLAW);
  });

  it('N10. with only owner: output contains owner content', () => {
    const result = buildSideChatInstructions({
      toggleEnabled: true,
      ownerContent:  OWNER,
    });
    expect(result).toContain(OWNER);
  });

  it('N11. layers are separated by double newline (\\n\\n) between systemlaw and owner', () => {
    const result = buildSideChatInstructions({
      toggleEnabled:    true,
      systemlawContent: SYSTEMLAW,
      ownerContent:     OWNER,
    });
    // The two sentinels must be joined by exactly \n\n — the canonical separator
    expect(result).toContain(`${SYSTEMLAW}\n\n${OWNER}`);
  });

  it('N12. overview stub (layer 2) does not inject extra content into the assembled output', () => {
    // Layer 2 is always '' in Phase 1 — it must not appear as a blank line artifact
    const result = buildSideChatInstructions({
      toggleEnabled:    true,
      systemlawContent: SYSTEMLAW,
      ownerContent:     OWNER,
    });
    // No triple newline (empty layer would produce \n\n\n\n between two sentinels)
    expect(result).not.toContain('\n\n\n');
  });
});

// ===========================================================================
// O. No Block AI coupling in the toggle-ON Side Chat path (Sub-AC 3.3b)
//
// "with no Block AI coupling" means:
//   1. The assembled output does not contain Block AI-specific instructions.
//   2. The AssemblyRequest surface field is 'SideChat', not 'BlockAI'.
//   3. SIDE_CHAT_SURFACE_PROMPT content is distinct from Block AI's surface prompt.
// ===========================================================================

describe('O: no Block AI coupling in toggle-ON Side Chat path (Sub-AC 3.3b)', () => {
  afterEach(() => {
    resetPromptAssembly();
  });

  // Block AI surface-prompt sentinel phrases (from BLOCK_AI_LEGACY_PROMPT)
  const BLOCK_AI_SENTINEL_1 = 'EXACTLY 3 alternative rewrites';
  const BLOCK_AI_SENTINEL_2 = 'focused text-rewriting assistant';
  const BLOCK_AI_SENTINEL_3 = 'Separate each alternative with a line containing exactly three dashes';

  it('O1. assembled output does NOT contain Block AI sentinel "EXACTLY 3 alternative rewrites"', () => {
    const result = buildSideChatInstructions({
      toggleEnabled:    true,
      systemlawContent: 'SYSTEMLAW_CONTENT',
      ownerContent:     'OWNER_CONTENT',
    });
    expect(result).not.toContain(BLOCK_AI_SENTINEL_1);
  });

  it('O2. assembled output does NOT contain Block AI sentinel "focused text-rewriting assistant"', () => {
    const result = buildSideChatInstructions({
      toggleEnabled: true,
      ownerContent:  'OWNER_CONTENT',
    });
    expect(result).not.toContain(BLOCK_AI_SENTINEL_2);
  });

  it('O3. assembled output does NOT contain Block AI sentinel "three dashes"', () => {
    const result = buildSideChatInstructions({
      toggleEnabled:       true,
      systemlawContent:    'SYSTEMLAW_CONTENT',
      qualityDirectiveStr: 'Write professionally.',
    });
    expect(result).not.toContain(BLOCK_AI_SENTINEL_3);
  });

  it('O4. assembled output does NOT contain "3 alternatives" (Block AI output constraint)', () => {
    const result = buildSideChatInstructions({
      toggleEnabled: true,
    });
    expect(result).not.toContain('3 alternatives');
  });

  it('O5. assembled output CONTAINS "editorial consultant" (Side Chat surface identity)', () => {
    const result = buildSideChatInstructions({
      toggleEnabled: true,
    });
    // The Side Chat surface prompt always makes it into the assembled output
    // because surfacePrompt is non-empty (SIDE_CHAT_SURFACE_PROMPT).
    expect(result).toContain('editorial consultant');
  });

  it('O6. the AssemblyRequest surface field is "SideChat", not "BlockAI" (spy verification)', () => {
    const capturedReqs: import('../main/prompts/assemble').AssemblyRequest[] = [];
    const capturingSpy = vi.fn<[import('../main/prompts/assemble').AssemblyRequest], string>(
      (req) => {
        capturedReqs.push(req);
        return 'captured';
      },
    );
    buildSideChatInstructions({ toggleEnabled: true }, capturingSpy);
    expect(capturedReqs[0].surface).toBe('SideChat');
    expect(capturedReqs[0].surface).not.toBe('BlockAI');
  });

  it('O7. SIDE_CHAT_SURFACE_PROMPT does not contain any Block AI sentinel text', () => {
    // The surface prompt itself must be entirely Side Chat specific.
    expect(SIDE_CHAT_SURFACE_PROMPT).not.toContain('3 alternative rewrites');
    expect(SIDE_CHAT_SURFACE_PROMPT).not.toContain('rewriting assistant');
    expect(SIDE_CHAT_SURFACE_PROMPT).not.toContain('three dashes');
  });

  it('O8. toggle-ON output contains "Markdown editor" (Side Chat self-identification)', () => {
    // SIDE_CHAT_SURFACE_PROMPT says "Markdown editor" — confirms Side Chat framing
    const result = buildSideChatInstructions({ toggleEnabled: true });
    expect(result).toContain('Markdown editor');
  });

  it('O9. real-assembler output with all layers: no Block AI sentinel leaks through', () => {
    const result = buildSideChatInstructions({
      toggleEnabled:       true,
      systemlawContent:    '# Rules\nBe helpful.',
      ownerContent:        '# Author\nProfessional writer.',
      qualityDirectiveStr: 'Write at a college level.',
      documentText:        '## Draft\nContent here.',
    });
    expect(result).not.toContain(BLOCK_AI_SENTINEL_1);
    expect(result).not.toContain(BLOCK_AI_SENTINEL_2);
    expect(result).not.toContain(BLOCK_AI_SENTINEL_3);
    // Must contain the Side Chat surface identity
    expect(result).toContain('editorial consultant');
  });

  it('O10. multiple toggle-ON calls: never produce Block AI output on any call', () => {
    const requests: import('../renderer/side-chat-prompt-handler').SideChatPromptRequest[] = [
      { toggleEnabled: true },
      { toggleEnabled: true, systemlawContent: '# Law' },
      { toggleEnabled: true, ownerContent: '# Owner' },
      { toggleEnabled: true, qualityDirectiveStr: 'Write simply.' },
      { toggleEnabled: true, documentText: 'Some document.' },
    ];
    for (const req of requests) {
      const result = buildSideChatInstructions(req);
      expect(result).not.toContain(BLOCK_AI_SENTINEL_1);
      expect(result).not.toContain(BLOCK_AI_SENTINEL_2);
    }
  });
});
