/**
 * quality-dial-adapter.test.ts
 *
 * Unit tests for `buildQualityDialInstructions(req, assemble?)`.
 *
 * Sub-AC 6.3d requirements:
 *   ✓ The Quality Dial surface adapter does not throw when the injected assembler
 *     returns a fallback-only stack.
 *   ✓ The Quality Dial surface adapter returns a non-empty string when the injected
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
 *   C. toggle-OFF path     — legacy quality directive returned; assembler never called
 *   D. toggle-ON path      — assembler is called with correct AssemblyRequest
 *   E. empty / partial params — graceful handling of missing fields
 *   F. assembler injection — default and mock assemblers behave correctly
 *   G. return-type guarantees — result is always a string
 *   H. quality directive content — correct directive for each quality level
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  buildQualityDialInstructions,
  type QualityDialPromptRequest,
  type AssemblerFn,
} from '../renderer/quality-dial-adapter';

import { qualityDirective, type Quality } from '../renderer/quality';
import type { AssemblyRequest } from '../main/prompts/assemble';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

/** Toggle-off request with default quality level. */
const TOGGLE_OFF_COLLEGE: QualityDialPromptRequest = {
  toggleEnabled: false,
  quality: 'college',
};

/** Toggle-off request with professional quality level. */
const TOGGLE_OFF_PROFESSIONAL: QualityDialPromptRequest = {
  toggleEnabled: false,
  quality: 'professional',
};

/** Minimal toggle-on request — no systemlaw or owner content. */
const TOGGLE_ON_MINIMAL: QualityDialPromptRequest = {
  toggleEnabled: true,
  quality: 'college',
};

/** Fully-populated toggle-on request. */
const TOGGLE_ON_FULL: QualityDialPromptRequest = {
  toggleEnabled: true,
  quality: 'professional',
  systemlawContent: '# Systemlaw\nBe helpful.',
  ownerContent: '# Owner\nI am a professional writer.',
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
  `Write at a college reading level: precise sentences, allow domain vocabulary with brief context, neutral professional tone.`;

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
    expect(() => buildQualityDialInstructions(TOGGLE_ON_MINIMAL, mockAssembler)).not.toThrow();
  });

  it('A2. [toggle-ON, fallback assembler] does not throw with full params', () => {
    expect(() => buildQualityDialInstructions(TOGGLE_ON_FULL, mockAssembler)).not.toThrow();
  });

  it('A3. [toggle-OFF] does not throw with college quality', () => {
    expect(() => buildQualityDialInstructions(TOGGLE_OFF_COLLEGE, mockAssembler)).not.toThrow();
  });

  it('A4. [toggle-OFF] does not throw with professional quality', () => {
    expect(() => buildQualityDialInstructions(TOGGLE_OFF_PROFESSIONAL, mockAssembler)).not.toThrow();
  });

  it('A5. [toggle-ON] does not throw when assembler returns empty string', () => {
    const emptyAssembler = vi.fn<[AssemblyRequest], string>().mockReturnValue('');
    expect(() => buildQualityDialInstructions(TOGGLE_ON_MINIMAL, emptyAssembler)).not.toThrow();
  });

  it('A6. [toggle-ON] does not throw when all optional params are explicitly empty strings', () => {
    const emptyParams: QualityDialPromptRequest = {
      toggleEnabled: true,
      quality: 'elementary',
      systemlawContent: '',
      ownerContent: '',
    };
    expect(() => buildQualityDialInstructions(emptyParams, mockAssembler)).not.toThrow();
  });

  it('A7. [toggle-ON] does not throw when optional params are undefined', () => {
    const params: QualityDialPromptRequest = {
      toggleEnabled: true,
      quality: 'highschool',
      systemlawContent: undefined,
      ownerContent: undefined,
    };
    expect(() => buildQualityDialInstructions(params, mockAssembler)).not.toThrow();
  });

  it('A8. [toggle-ON] does not throw for every valid quality level', () => {
    const levels: Quality[] = ['elementary', 'highschool', 'college', 'professor', 'professional'];
    for (const quality of levels) {
      expect(() =>
        buildQualityDialInstructions({ toggleEnabled: true, quality }, mockAssembler)
      ).not.toThrow();
    }
  });
});

// ===========================================================================
// B. fallback-only stack — PRIMARY AC requirement (Sub-AC 6.3d)
// ===========================================================================

describe('B: fallback-only stack — primary Sub-AC 6.3d requirement', () => {
  /**
   * PRIMARY TEST for Sub-AC 6.3d:
   * When the assembler is mocked to return a fallback-only stack,
   * the Quality Dial adapter must (1) not throw, AND (2) return a non-empty string.
   */
  it('B1. [PRIMARY] toggle-ON with fallback assembler: does not throw AND returns non-empty string', () => {
    let result: string | undefined;

    // (1) no-throw assertion
    expect(() => {
      result = buildQualityDialInstructions(TOGGLE_ON_MINIMAL, mockAssembler);
    }).not.toThrow();

    // (2) non-empty-string assertion
    expect(typeof result).toBe('string');
    expect((result as string).length).toBeGreaterThan(0);
  });

  it('B2. result equals what the fallback assembler returned (no transformation)', () => {
    const result = buildQualityDialInstructions(TOGGLE_ON_MINIMAL, mockAssembler);
    expect(result).toBe(FALLBACK_ONLY_STACK);
  });

  it('B3. result is a string type (not null, undefined, or other)', () => {
    const result = buildQualityDialInstructions(TOGGLE_ON_MINIMAL, mockAssembler);
    expect(typeof result).toBe('string');
    expect(result).not.toBeNull();
    expect(result).not.toBeUndefined();
  });

  it('B4. fallback-only stack with full params: does not throw AND returns non-empty string', () => {
    let result: string | undefined;
    expect(() => {
      result = buildQualityDialInstructions(TOGGLE_ON_FULL, mockAssembler);
    }).not.toThrow();
    expect(typeof result).toBe('string');
    expect((result as string).length).toBeGreaterThan(0);
  });

  it('B5. assembler is called exactly once per buildQualityDialInstructions call (toggle-ON)', () => {
    buildQualityDialInstructions(TOGGLE_ON_MINIMAL, mockAssembler);
    expect(mockAssembler).toHaveBeenCalledTimes(1);
  });

  it('B6. assembler is called with surface: "QualityDial" (toggle-ON)', () => {
    buildQualityDialInstructions(TOGGLE_ON_MINIMAL, mockAssembler);
    expect(mockAssembler).toHaveBeenCalledWith(
      expect.objectContaining({ surface: 'QualityDial' }),
    );
  });

  it('B7. fallback-only stack string passes the "usable prompt" bar — trimmed length > 0', () => {
    const result = buildQualityDialInstructions(TOGGLE_ON_MINIMAL, mockAssembler);
    expect(result.trim().length).toBeGreaterThan(0);
  });

  it('B8. [toggle-ON, professional quality] fallback assembler: does not throw AND non-empty', () => {
    let result: string | undefined;
    expect(() => {
      result = buildQualityDialInstructions(TOGGLE_ON_FULL, mockAssembler);
    }).not.toThrow();
    expect((result as string).length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// C. toggle-OFF path — legacy quality directive returned; assembler never called
// ===========================================================================

describe('C: toggle-OFF path — legacy quality directive, assembler not called', () => {
  it('C1. [toggle-OFF] returns a non-empty string without calling the assembler', () => {
    const result = buildQualityDialInstructions(TOGGLE_OFF_COLLEGE, mockAssembler);
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
    expect(mockAssembler).not.toHaveBeenCalled();
  });

  it('C2. [toggle-OFF] result equals the legacy qualityDirective output for "college"', () => {
    const result = buildQualityDialInstructions(TOGGLE_OFF_COLLEGE, mockAssembler);
    expect(result).toBe(qualityDirective('college'));
  });

  it('C3. [toggle-OFF] result equals the legacy qualityDirective output for "professional"', () => {
    const result = buildQualityDialInstructions(TOGGLE_OFF_PROFESSIONAL, mockAssembler);
    expect(result).toBe(qualityDirective('professional'));
  });

  it('C4. [toggle-OFF] systemlawContent and ownerContent are ignored', () => {
    const params: QualityDialPromptRequest = {
      toggleEnabled: false,
      quality: 'college',
      systemlawContent: 'SYSTEMLAW_SHOULD_NOT_APPEAR',
      ownerContent: 'OWNER_SHOULD_NOT_APPEAR',
    };
    const result = buildQualityDialInstructions(params, mockAssembler);
    expect(result).not.toContain('SYSTEMLAW_SHOULD_NOT_APPEAR');
    expect(result).not.toContain('OWNER_SHOULD_NOT_APPEAR');
  });

  it('C5. [toggle-OFF] assembler is NEVER called regardless of other fields', () => {
    buildQualityDialInstructions(TOGGLE_OFF_PROFESSIONAL, mockAssembler);
    expect(mockAssembler).not.toHaveBeenCalled();
  });

  it('C6. [toggle-OFF] returns correct directive for each quality level', () => {
    const levels: Quality[] = ['elementary', 'highschool', 'college', 'professor', 'professional'];
    for (const quality of levels) {
      const result = buildQualityDialInstructions({ toggleEnabled: false, quality }, mockAssembler);
      expect(result).toBe(qualityDirective(quality));
    }
    expect(mockAssembler).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// D. toggle-ON path — assembler called with correct AssemblyRequest
// ===========================================================================

describe('D: toggle-ON path — assembler receives correct AssemblyRequest', () => {
  it('D1. assembler receives systemlawContent from params', () => {
    buildQualityDialInstructions({ toggleEnabled: true, quality: 'college', systemlawContent: 'MY_SYSTEMLAW' }, mockAssembler);
    expect(mockAssembler).toHaveBeenCalledWith(
      expect.objectContaining({ systemlawContent: 'MY_SYSTEMLAW' }),
    );
  });

  it('D2. assembler receives ownerContent from params', () => {
    buildQualityDialInstructions({ toggleEnabled: true, quality: 'college', ownerContent: 'MY_OWNER' }, mockAssembler);
    expect(mockAssembler).toHaveBeenCalledWith(
      expect.objectContaining({ ownerContent: 'MY_OWNER' }),
    );
  });

  it('D3. assembler receives qualityDirective matching qualityDirective(req.quality)', () => {
    const quality: Quality = 'professional';
    buildQualityDialInstructions({ toggleEnabled: true, quality }, mockAssembler);
    expect(mockAssembler).toHaveBeenCalledWith(
      expect.objectContaining({ qualityDirective: qualityDirective(quality) }),
    );
  });

  it('D4. assembler receives surface: "QualityDial"', () => {
    buildQualityDialInstructions(TOGGLE_ON_MINIMAL, mockAssembler);
    expect(mockAssembler).toHaveBeenCalledWith(
      expect.objectContaining({ surface: 'QualityDial' }),
    );
  });

  it('D5. absent optional params default to empty string in AssemblyRequest', () => {
    const capturedReqs: AssemblyRequest[] = [];
    const capturingAssembler = vi.fn<[AssemblyRequest], string>((req) => {
      capturedReqs.push(req);
      return FALLBACK_ONLY_STACK;
    });
    buildQualityDialInstructions(TOGGLE_ON_MINIMAL, capturingAssembler);
    const req = capturedReqs[0];
    expect(req.systemlawContent).toBe('');
    expect(req.ownerContent).toBe('');
  });

  it('D6. assembler is called exactly once per invocation (toggle-ON)', () => {
    buildQualityDialInstructions(TOGGLE_ON_FULL, mockAssembler);
    expect(mockAssembler).toHaveBeenCalledTimes(1);
  });

  it('D7. assembler returns its value verbatim when toggle is on', () => {
    mockAssembler.mockReturnValue('CUSTOM_OUTPUT');
    const result = buildQualityDialInstructions(TOGGLE_ON_MINIMAL, mockAssembler);
    expect(result).toBe('CUSTOM_OUTPUT');
  });

  it('D8. assembler receives correct qualityDirective for each quality level (toggle-ON)', () => {
    const levels: Quality[] = ['elementary', 'highschool', 'college', 'professor', 'professional'];
    for (const quality of levels) {
      const capturedReqs: AssemblyRequest[] = [];
      const cap = vi.fn<[AssemblyRequest], string>((req) => {
        capturedReqs.push(req);
        return FALLBACK_ONLY_STACK;
      });
      buildQualityDialInstructions({ toggleEnabled: true, quality }, cap);
      expect(capturedReqs[0].qualityDirective).toBe(qualityDirective(quality));
    }
  });
});

// ===========================================================================
// E. empty / partial params — graceful handling
// ===========================================================================

describe('E: empty / partial params — graceful fallback', () => {
  it('E1. [toggle-ON] minimal params (no systemlaw/owner): does not throw, returns string', () => {
    let result: unknown;
    expect(() => {
      result = buildQualityDialInstructions(TOGGLE_ON_MINIMAL, mockAssembler);
    }).not.toThrow();
    expect(typeof result).toBe('string');
  });

  it('E2. [toggle-ON] only systemlawContent provided: does not throw, returns string', () => {
    let result: unknown;
    expect(() => {
      result = buildQualityDialInstructions({ toggleEnabled: true, quality: 'college', systemlawContent: 'sl' }, mockAssembler);
    }).not.toThrow();
    expect(typeof result).toBe('string');
  });

  it('E3. [toggle-ON] only ownerContent provided: does not throw, returns string', () => {
    let result: unknown;
    expect(() => {
      result = buildQualityDialInstructions({ toggleEnabled: true, quality: 'college', ownerContent: 'owner' }, mockAssembler);
    }).not.toThrow();
    expect(typeof result).toBe('string');
  });

  it('E4. [toggle-ON] empty string systemlawContent/ownerContent: does not crash', () => {
    expect(() =>
      buildQualityDialInstructions({ toggleEnabled: true, quality: 'college', systemlawContent: '', ownerContent: '' }, mockAssembler)
    ).not.toThrow();
  });

  it('E5. [toggle-ON] undefined optional params do not cause ReferenceError', () => {
    const params: QualityDialPromptRequest = {
      toggleEnabled: true,
      quality: 'professor',
      systemlawContent: undefined,
      ownerContent: undefined,
    };
    expect(() => buildQualityDialInstructions(params, mockAssembler)).not.toThrow();
  });
});

// ===========================================================================
// F. assembler injection — mock vs default
// ===========================================================================

describe('F: assembler injection — mock vs default', () => {
  it('F1. mock assembler is called instead of the real assemblePrompt (toggle-ON)', () => {
    const SENTINEL = 'MOCK_ASSEMBLER_WAS_CALLED';
    const sentinelAssembler = vi.fn<[AssemblyRequest], string>().mockReturnValue(SENTINEL);
    const result = buildQualityDialInstructions(TOGGLE_ON_MINIMAL, sentinelAssembler);
    expect(result).toBe(SENTINEL);
    expect(sentinelAssembler).toHaveBeenCalledTimes(1);
  });

  it('F2. mock assembler returning fallback string produces non-empty result (toggle-ON)', () => {
    const result = buildQualityDialInstructions(TOGGLE_ON_MINIMAL, mockAssembler);
    expect(result.length).toBeGreaterThan(0);
    expect(result).toBe(FALLBACK_ONLY_STACK);
  });

  it('F3. [toggle-OFF] mock assembler is NEVER called when toggle is off', () => {
    buildQualityDialInstructions(TOGGLE_OFF_PROFESSIONAL, mockAssembler);
    expect(mockAssembler).not.toHaveBeenCalled();
  });

  it('F4. toggle flip: assembler called when ON, not called when OFF', () => {
    // Toggle OFF — assembler not called
    buildQualityDialInstructions(TOGGLE_OFF_COLLEGE, mockAssembler);
    expect(mockAssembler).toHaveBeenCalledTimes(0);

    // Toggle ON — assembler called once
    buildQualityDialInstructions(TOGGLE_ON_MINIMAL, mockAssembler);
    expect(mockAssembler).toHaveBeenCalledTimes(1);

    // Toggle OFF again — assembler not called again
    buildQualityDialInstructions(TOGGLE_OFF_COLLEGE, mockAssembler);
    expect(mockAssembler).toHaveBeenCalledTimes(1);  // still 1
  });

  it('F5. multiple toggle-on calls all call the assembler', () => {
    for (let i = 0; i < 4; i++) {
      buildQualityDialInstructions(TOGGLE_ON_MINIMAL, mockAssembler);
    }
    expect(mockAssembler).toHaveBeenCalledTimes(4);
  });

  it('F6. multiple toggle-off calls never call the assembler', () => {
    for (let i = 0; i < 5; i++) {
      buildQualityDialInstructions(TOGGLE_OFF_COLLEGE, mockAssembler);
    }
    expect(mockAssembler).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// G. return-type guarantees — result is always a string
// ===========================================================================

describe('G: return-type guarantees — result is always a string', () => {
  it('G1. [toggle-OFF, college] returns string', () => {
    const result = buildQualityDialInstructions(TOGGLE_OFF_COLLEGE, mockAssembler);
    expect(typeof result).toBe('string');
  });

  it('G2. [toggle-OFF, professional] returns string', () => {
    const result = buildQualityDialInstructions(TOGGLE_OFF_PROFESSIONAL, mockAssembler);
    expect(typeof result).toBe('string');
  });

  it('G3. [toggle-ON, fallback assembler] returns string', () => {
    const result = buildQualityDialInstructions(TOGGLE_ON_MINIMAL, mockAssembler);
    expect(typeof result).toBe('string');
  });

  it('G4. [toggle-ON, assembler returning ""] returns empty string (never null)', () => {
    const emptyAssembler = vi.fn<[AssemblyRequest], string>().mockReturnValue('');
    const result = buildQualityDialInstructions(TOGGLE_ON_MINIMAL, emptyAssembler);
    expect(typeof result).toBe('string');
    expect(result).not.toBeNull();
    expect(result).not.toBeUndefined();
    expect(result).toBe('');
  });

  it('G5. [toggle-OFF] result is always non-empty (quality directive always has content)', () => {
    const levels: Quality[] = ['elementary', 'highschool', 'college', 'professor', 'professional'];
    for (const quality of levels) {
      const result = buildQualityDialInstructions({ toggleEnabled: false, quality });
      expect(result.trim().length).toBeGreaterThan(0);
    }
  });

  it('G6. [toggle-ON, full params, fallback assembler] result is non-null string', () => {
    const result = buildQualityDialInstructions(TOGGLE_ON_FULL, mockAssembler);
    expect(typeof result).toBe('string');
    expect(result).not.toBeNull();
    expect(result).not.toBeUndefined();
  });
});

// ===========================================================================
// H. quality directive content — correct directive for each quality level
// ===========================================================================

describe('H: quality directive content — adapter uses correct directive per level', () => {
  it('H1. [toggle-OFF] "elementary" produces directive containing "elementary"', () => {
    const result = buildQualityDialInstructions({ toggleEnabled: false, quality: 'elementary' });
    expect(result.toLowerCase()).toContain('elementary');
  });

  it('H2. [toggle-OFF] "highschool" produces directive containing "high-school"', () => {
    const result = buildQualityDialInstructions({ toggleEnabled: false, quality: 'highschool' });
    // qualityDirective returns "Write at a high-school reading level..."
    expect(result.toLowerCase()).toContain('high-school');
  });

  it('H3. [toggle-OFF] "college" produces directive containing "college"', () => {
    const result = buildQualityDialInstructions({ toggleEnabled: false, quality: 'college' });
    expect(result.toLowerCase()).toContain('college');
  });

  it('H4. [toggle-OFF] "professor" produces directive containing "professor"', () => {
    const result = buildQualityDialInstructions({ toggleEnabled: false, quality: 'professor' });
    expect(result.toLowerCase()).toContain('professor');
  });

  it('H5. [toggle-OFF] "professional" produces directive containing "senior-practitioner"', () => {
    const result = buildQualityDialInstructions({ toggleEnabled: false, quality: 'professional' });
    // qualityDirective('professional') returns "Write at a senior-practitioner reading level..."
    expect(result.toLowerCase()).toContain('senior-practitioner');
  });

  it('H6. [toggle-ON] assembler receives qualityDirective for "elementary" quality', () => {
    buildQualityDialInstructions({ toggleEnabled: true, quality: 'elementary' }, mockAssembler);
    const [calledReq] = mockAssembler.mock.calls[0];
    expect(calledReq.qualityDirective?.toLowerCase()).toContain('elementary');
  });

  it('H7. [toggle-ON] assembler receives qualityDirective for "professional" quality', () => {
    buildQualityDialInstructions({ toggleEnabled: true, quality: 'professional' }, mockAssembler);
    const [calledReq] = mockAssembler.mock.calls[0];
    // qualityDirective('professional') returns "Write at a senior-practitioner reading level..."
    expect(calledReq.qualityDirective?.toLowerCase()).toContain('senior-practitioner');
  });
});
