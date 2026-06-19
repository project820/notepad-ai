/**
 * block-ai-adapter.test.ts
 *
 * Unit tests for `buildBlockAiSystemPrompt` (src/main/prompts/block-ai-adapter.ts).
 *
 * Sub-AC 6.3a requirements:
 *   ✓ The Block AI surface adapter does not throw when the injected assembler
 *     returns a fallback-only stack.
 *   ✓ The Block AI surface adapter returns a non-empty string when the injected
 *     assembler returns a fallback-only stack.
 *   ✓ Verified by at least one unit test covering both no-throw AND
 *     non-empty-string assertions.
 *
 * "Fallback-only stack" — the assembled string returned by `assemblePrompt`
 * when both readers return their defaults (no systemlaw.md, no Owner.md).
 * In the pipeline this evaluates to `SYSTEMLAW_DEFAULT + "\n\n" + OWNER_DEFAULT`.
 * For testing purposes we simulate this with a representative non-empty string.
 *
 * Test groups:
 *   A. no-throw guarantee — adapter never throws regardless of inputs
 *   B. fallback-only stack — assembler returns default content, adapter passes through
 *   C. toggle-OFF path     — v1.0 legacy prompt returned; assembler never called
 *   D. toggle-ON path      — assembler is called with correct AssemblyRequest
 *   E. empty / partial params — graceful handling of missing fields
 *   F. assembler injection — default and mock assemblers behave correctly
 *   G. return-type guarantees — result is always a string
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  buildBlockAiSystemPrompt,
  BLOCK_AI_LEGACY_PROMPT,
  type BlockAiPromptParams,
} from '../../src/main/prompts/block-ai-adapter';
import {
  setPromptAssemblyEnabled,
  resetPromptAssembly,
} from '../../src/main/prompts/toggle';
import type { AssemblyRequest, AssembledPrompt } from '../../src/main/prompts/assemble';

// ---------------------------------------------------------------------------
// Test-isolation: reset toggle state after every test.
// ---------------------------------------------------------------------------

afterEach(() => {
  resetPromptAssembly();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Fixture: "fallback-only stack" — what the assembler returns when both
// userData files are absent and the reader defaults kick in.
// ---------------------------------------------------------------------------

/**
 * Representative fallback-only stack content.
 *
 * In a real pipeline this would be `SYSTEMLAW_DEFAULT + "\n\n" + OWNER_DEFAULT`.
 * Using a labeled placeholder here keeps the test readable and ensures the
 * adapter does not interpret or transform the assembler's output.
 */
const FALLBACK_ONLY_STACK =
  `# AI Conduct Rules\nBe concise. Respond in the user's language.\n\n` +
  `# About the Author\nName: (not yet configured)\n` +
  `Role: (not yet configured)\n\n` +
  `You are a focused text-rewriting assistant inside a Markdown editor.`;

/** Mock assembler that always returns the fallback-only stack. */
function makeFallbackAssembler(): (req: AssemblyRequest) => AssembledPrompt {
  return vi.fn<[AssemblyRequest], AssembledPrompt>().mockReturnValue(FALLBACK_ONLY_STACK);
}

/** Minimal valid params — all fields absent / defaults. */
const MINIMAL_PARAMS: BlockAiPromptParams = {};

/** Full params representing a real Block AI invocation. */
const FULL_PARAMS: BlockAiPromptParams = {
  systemlawContent: '# AI Conduct Rules\nBe concise.',
  ownerContent:     '# About the Author\nName: 김동인',
  qualityDirective: 'Write at a professional level.',
  fragment:         '# My Report\nQ1 results show 15% growth.',
  instruction:      'Rewrite as three bullet points.',
};

// ===========================================================================
// A. no-throw guarantee — adapter never throws regardless of inputs
// ===========================================================================

describe('A. no-throw guarantee — adapter never throws', () => {
  it('A1. [toggle-ON, fallback assembler] does not throw with minimal params', () => {
    setPromptAssemblyEnabled(true);
    const mockAssembler = makeFallbackAssembler();
    expect(() => buildBlockAiSystemPrompt(MINIMAL_PARAMS, mockAssembler)).not.toThrow();
  });

  it('A2. [toggle-ON, fallback assembler] does not throw with full params', () => {
    setPromptAssemblyEnabled(true);
    const mockAssembler = makeFallbackAssembler();
    expect(() => buildBlockAiSystemPrompt(FULL_PARAMS, mockAssembler)).not.toThrow();
  });

  it('A3. [toggle-OFF] does not throw with minimal params', () => {
    // toggle is off by default after resetPromptAssembly
    expect(() => buildBlockAiSystemPrompt(MINIMAL_PARAMS)).not.toThrow();
  });

  it('A4. [toggle-OFF] does not throw with full params', () => {
    expect(() => buildBlockAiSystemPrompt(FULL_PARAMS)).not.toThrow();
  });

  it('A5. [toggle-ON] does not throw when assembler returns empty string', () => {
    setPromptAssemblyEnabled(true);
    const emptyAssembler = vi.fn<[AssemblyRequest], AssembledPrompt>().mockReturnValue('');
    expect(() => buildBlockAiSystemPrompt(MINIMAL_PARAMS, emptyAssembler)).not.toThrow();
  });

  it('A6. [toggle-ON] does not throw when all params are explicitly empty strings', () => {
    setPromptAssemblyEnabled(true);
    const mockAssembler = makeFallbackAssembler();
    const emptyParams: BlockAiPromptParams = {
      systemlawContent: '',
      ownerContent:     '',
      qualityDirective: '',
      fragment:         '',
      instruction:      '',
    };
    expect(() => buildBlockAiSystemPrompt(emptyParams, mockAssembler)).not.toThrow();
  });

  it('A7. [toggle-ON] does not throw when assembler receives all-empty AssemblyRequest', () => {
    setPromptAssemblyEnabled(true);
    const capturedReqs: AssemblyRequest[] = [];
    const capturingAssembler = vi.fn<[AssemblyRequest], AssembledPrompt>((req) => {
      capturedReqs.push(req);
      return FALLBACK_ONLY_STACK;
    });
    expect(() => buildBlockAiSystemPrompt(MINIMAL_PARAMS, capturingAssembler)).not.toThrow();
  });
});

// ===========================================================================
// B. fallback-only stack — primary AC requirement
// ===========================================================================

describe('B. fallback-only stack — adapter returns usable string from mock assembler', () => {
  /**
   * PRIMARY TEST for Sub-AC 6.3a:
   * When the assembler is mocked to return a fallback-only stack,
   * the Block AI adapter must (1) not throw, AND (2) return a non-empty string.
   */
  it('B1. [primary] toggle-ON with fallback assembler: does not throw AND returns non-empty string', () => {
    setPromptAssemblyEnabled(true);
    const mockAssembler = makeFallbackAssembler();

    let result: string | undefined;
    // (1) no-throw assertion
    expect(() => {
      result = buildBlockAiSystemPrompt(MINIMAL_PARAMS, mockAssembler);
    }).not.toThrow();

    // (2) non-empty-string assertion
    expect(typeof result).toBe('string');
    expect((result as string).length).toBeGreaterThan(0);
  });

  it('B2. result equals what the fallback assembler returned (no transformation)', () => {
    setPromptAssemblyEnabled(true);
    const mockAssembler = makeFallbackAssembler();

    const result = buildBlockAiSystemPrompt(MINIMAL_PARAMS, mockAssembler);

    // The adapter must pass the assembler's output through unchanged.
    expect(result).toBe(FALLBACK_ONLY_STACK);
  });

  it('B3. result is a string type (not null, undefined, or other)', () => {
    setPromptAssemblyEnabled(true);
    const mockAssembler = makeFallbackAssembler();

    const result = buildBlockAiSystemPrompt(MINIMAL_PARAMS, mockAssembler);

    expect(typeof result).toBe('string');
    expect(result).not.toBeNull();
    expect(result).not.toBeUndefined();
  });

  it('B4. fallback-only stack with full params: does not throw AND returns non-empty string', () => {
    setPromptAssemblyEnabled(true);
    const mockAssembler = makeFallbackAssembler();

    let result: string | undefined;
    expect(() => {
      result = buildBlockAiSystemPrompt(FULL_PARAMS, mockAssembler);
    }).not.toThrow();

    expect(typeof result).toBe('string');
    expect((result as string).length).toBeGreaterThan(0);
  });

  it('B5. assembler is called exactly once per buildBlockAiSystemPrompt call (toggle-ON)', () => {
    setPromptAssemblyEnabled(true);
    const mockAssembler = makeFallbackAssembler();

    buildBlockAiSystemPrompt(MINIMAL_PARAMS, mockAssembler);

    expect(mockAssembler).toHaveBeenCalledTimes(1);
  });

  it('B6. assembler is called with surface: "BlockAI" (toggle-ON)', () => {
    setPromptAssemblyEnabled(true);
    const mockAssembler = makeFallbackAssembler();

    buildBlockAiSystemPrompt(MINIMAL_PARAMS, mockAssembler);

    expect(mockAssembler).toHaveBeenCalledWith(
      expect.objectContaining({ surface: 'BlockAI' }),
    );
  });

  it('B7. fallback-only stack string passes the "usable prompt" bar — trimmed length > 0', () => {
    setPromptAssemblyEnabled(true);
    const mockAssembler = makeFallbackAssembler();

    const result = buildBlockAiSystemPrompt(MINIMAL_PARAMS, mockAssembler);

    // "usable" means it can be sent to the API without being rejected as empty
    expect(result.trim().length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// C. toggle-OFF path — v1.0 legacy prompt returned; assembler never called
// ===========================================================================

describe('C. toggle-OFF path — v1.0 legacy prompt; assembler unused', () => {
  it('C1. [toggle-OFF] returns a non-empty string without calling the assembler', () => {
    // toggle is off by default
    const mockAssembler = makeFallbackAssembler();
    const result = buildBlockAiSystemPrompt(MINIMAL_PARAMS, mockAssembler);

    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
    // Assembler must not be called when toggle is off
    expect(mockAssembler).not.toHaveBeenCalled();
  });

  it('C2. [toggle-OFF] result contains BLOCK_AI_LEGACY_PROMPT verbatim', () => {
    const result = buildBlockAiSystemPrompt(MINIMAL_PARAMS);

    expect(result).toContain(BLOCK_AI_LEGACY_PROMPT);
  });

  it('C3. [toggle-OFF] quality directive is appended with \\n\\n separator when non-empty', () => {
    const params: BlockAiPromptParams = { qualityDirective: 'Write at a professional level.' };
    const result = buildBlockAiSystemPrompt(params);

    expect(result).toContain(BLOCK_AI_LEGACY_PROMPT);
    expect(result).toContain('Write at a professional level.');
    // Separator between legacy prompt and quality directive
    expect(result).toContain('\n\n');
  });

  it('C4. [toggle-OFF] empty qualityDirective: no trailing \\n\\n after legacy prompt', () => {
    const params: BlockAiPromptParams = { qualityDirective: '' };
    const result = buildBlockAiSystemPrompt(params);

    // Result should be exactly the legacy prompt — no trailing separator
    expect(result).toBe(BLOCK_AI_LEGACY_PROMPT);
  });

  it('C5. [toggle-OFF] whitespace-only qualityDirective is treated as empty (no trailing \\n\\n)', () => {
    const params: BlockAiPromptParams = { qualityDirective: '   \n\n  ' };
    const result = buildBlockAiSystemPrompt(params);

    expect(result).toBe(BLOCK_AI_LEGACY_PROMPT);
  });

  it('C6. [toggle-OFF] systemlawContent and ownerContent are ignored', () => {
    const params: BlockAiPromptParams = {
      systemlawContent: 'SYSTEMLAW_SHOULD_NOT_APPEAR',
      ownerContent:     'OWNER_SHOULD_NOT_APPEAR',
    };
    const result = buildBlockAiSystemPrompt(params);

    // These inputs are v1.1 features; toggle-off path ignores them
    expect(result).not.toContain('SYSTEMLAW_SHOULD_NOT_APPEAR');
    expect(result).not.toContain('OWNER_SHOULD_NOT_APPEAR');
  });
});

// ===========================================================================
// D. toggle-ON path — assembler called with correct AssemblyRequest
// ===========================================================================

describe('D. toggle-ON path — assembler called with correct AssemblyRequest', () => {
  it('D1. assembler receives systemlawContent from params', () => {
    setPromptAssemblyEnabled(true);
    const mockAssembler = makeFallbackAssembler();

    buildBlockAiSystemPrompt({ systemlawContent: 'MY_SYSTEMLAW' }, mockAssembler);

    expect(mockAssembler).toHaveBeenCalledWith(
      expect.objectContaining({ systemlawContent: 'MY_SYSTEMLAW' }),
    );
  });

  it('D2. assembler receives ownerContent from params', () => {
    setPromptAssemblyEnabled(true);
    const mockAssembler = makeFallbackAssembler();

    buildBlockAiSystemPrompt({ ownerContent: 'MY_OWNER' }, mockAssembler);

    expect(mockAssembler).toHaveBeenCalledWith(
      expect.objectContaining({ ownerContent: 'MY_OWNER' }),
    );
  });

  it('D3. assembler receives qualityDirective from params', () => {
    setPromptAssemblyEnabled(true);
    const mockAssembler = makeFallbackAssembler();

    buildBlockAiSystemPrompt({ qualityDirective: 'QUALITY_DIRECTIVE' }, mockAssembler);

    expect(mockAssembler).toHaveBeenCalledWith(
      expect.objectContaining({ qualityDirective: 'QUALITY_DIRECTIVE' }),
    );
  });

  it('D4. assembler receives documentText = fragment from params', () => {
    setPromptAssemblyEnabled(true);
    const mockAssembler = makeFallbackAssembler();

    buildBlockAiSystemPrompt({ fragment: 'SELECTED_TEXT' }, mockAssembler);

    expect(mockAssembler).toHaveBeenCalledWith(
      expect.objectContaining({ documentText: 'SELECTED_TEXT' }),
    );
  });

  it('D5. assembler receives userInstruction = instruction from params', () => {
    setPromptAssemblyEnabled(true);
    const mockAssembler = makeFallbackAssembler();

    buildBlockAiSystemPrompt({ instruction: 'USER_INSTRUCTION' }, mockAssembler);

    expect(mockAssembler).toHaveBeenCalledWith(
      expect.objectContaining({ userInstruction: 'USER_INSTRUCTION' }),
    );
  });

  it('D6. assembler receives surfacePrompt = BLOCK_AI_LEGACY_PROMPT (Layer 3)', () => {
    setPromptAssemblyEnabled(true);
    const mockAssembler = makeFallbackAssembler();

    buildBlockAiSystemPrompt(MINIMAL_PARAMS, mockAssembler);

    expect(mockAssembler).toHaveBeenCalledWith(
      expect.objectContaining({ surfacePrompt: BLOCK_AI_LEGACY_PROMPT }),
    );
  });

  it('D7. absent params default to empty string in AssemblyRequest (not undefined breakage)', () => {
    setPromptAssemblyEnabled(true);
    const capturedReqs: AssemblyRequest[] = [];
    const capturingAssembler = vi.fn<[AssemblyRequest], AssembledPrompt>((req) => {
      capturedReqs.push(req);
      return FALLBACK_ONLY_STACK;
    });

    buildBlockAiSystemPrompt(MINIMAL_PARAMS, capturingAssembler);

    const req = capturedReqs[0];
    expect(req.systemlawContent).toBe('');
    expect(req.ownerContent).toBe('');
    expect(req.qualityDirective).toBe('');
    expect(req.documentText).toBe('');
    expect(req.userInstruction).toBe('');
  });
});

// ===========================================================================
// E. empty / partial params — graceful handling of missing fields
// ===========================================================================

describe('E. empty / partial params — graceful fallback', () => {
  it('E1. [toggle-ON] all-empty params: does not throw, returns string', () => {
    setPromptAssemblyEnabled(true);
    const mockAssembler = makeFallbackAssembler();

    let result: unknown;
    expect(() => { result = buildBlockAiSystemPrompt({}, mockAssembler); }).not.toThrow();
    expect(typeof result).toBe('string');
  });

  it('E2. [toggle-ON] only fragment provided: does not throw, returns string', () => {
    setPromptAssemblyEnabled(true);
    const mockAssembler = makeFallbackAssembler();

    let result: unknown;
    expect(() => { result = buildBlockAiSystemPrompt({ fragment: 'text' }, mockAssembler); }).not.toThrow();
    expect(typeof result).toBe('string');
  });

  it('E3. [toggle-ON] only instruction provided: does not throw, returns string', () => {
    setPromptAssemblyEnabled(true);
    const mockAssembler = makeFallbackAssembler();

    let result: unknown;
    expect(() => { result = buildBlockAiSystemPrompt({ instruction: 'do this' }, mockAssembler); }).not.toThrow();
    expect(typeof result).toBe('string');
  });

  it('E4. [toggle-OFF] missing qualityDirective: returns BLOCK_AI_LEGACY_PROMPT exactly', () => {
    const result = buildBlockAiSystemPrompt({});
    expect(result).toBe(BLOCK_AI_LEGACY_PROMPT);
  });

  it('E5. [toggle-ON] undefined fields do not cause ReferenceError', () => {
    setPromptAssemblyEnabled(true);
    const mockAssembler = makeFallbackAssembler();
    const params: BlockAiPromptParams = {
      systemlawContent: undefined,
      ownerContent:     undefined,
      qualityDirective: undefined,
      fragment:         undefined,
      instruction:      undefined,
    };
    expect(() => buildBlockAiSystemPrompt(params, mockAssembler)).not.toThrow();
  });
});

// ===========================================================================
// F. assembler injection — default and mock assemblers behave correctly
// ===========================================================================

describe('F. assembler injection — mock vs default', () => {
  it('F1. mock assembler is called instead of the real assemblePrompt (toggle-ON)', () => {
    setPromptAssemblyEnabled(true);
    const SENTINEL = 'MOCK_ASSEMBLER_WAS_CALLED';
    const sentinelAssembler = vi.fn<[AssemblyRequest], AssembledPrompt>().mockReturnValue(SENTINEL);

    const result = buildBlockAiSystemPrompt(MINIMAL_PARAMS, sentinelAssembler);

    expect(result).toBe(SENTINEL);
    expect(sentinelAssembler).toHaveBeenCalledTimes(1);
  });

  it('F2. mock assembler returning fallback string produces non-empty result (toggle-ON)', () => {
    setPromptAssemblyEnabled(true);
    const mockAssembler = makeFallbackAssembler();

    const result = buildBlockAiSystemPrompt(MINIMAL_PARAMS, mockAssembler);

    expect(result.length).toBeGreaterThan(0);
    expect(result).toBe(FALLBACK_ONLY_STACK);
  });

  it('F3. [toggle-OFF] mock assembler is NEVER called when toggle is off', () => {
    // toggle is off by default
    const mockAssembler = makeFallbackAssembler();

    buildBlockAiSystemPrompt(FULL_PARAMS, mockAssembler);

    expect(mockAssembler).not.toHaveBeenCalled();
  });

  it('F4. toggle flip: assembler called when ON, not called when OFF', () => {
    const mockAssembler = makeFallbackAssembler();

    // Toggle OFF (default) — assembler not called
    buildBlockAiSystemPrompt(MINIMAL_PARAMS, mockAssembler);
    expect(mockAssembler).toHaveBeenCalledTimes(0);

    // Toggle ON — assembler called once
    setPromptAssemblyEnabled(true);
    buildBlockAiSystemPrompt(MINIMAL_PARAMS, mockAssembler);
    expect(mockAssembler).toHaveBeenCalledTimes(1);

    // Toggle OFF again — assembler not called again
    setPromptAssemblyEnabled(false);
    buildBlockAiSystemPrompt(MINIMAL_PARAMS, mockAssembler);
    expect(mockAssembler).toHaveBeenCalledTimes(1);  // still 1
  });
});

// ===========================================================================
// G. return-type guarantees — result is always a string
// ===========================================================================

describe('G. return-type guarantees — result is always a string', () => {
  it('G1. [toggle-OFF, minimal params] returns string', () => {
    const result = buildBlockAiSystemPrompt(MINIMAL_PARAMS);
    expect(typeof result).toBe('string');
  });

  it('G2. [toggle-OFF, full params] returns string', () => {
    const result = buildBlockAiSystemPrompt(FULL_PARAMS);
    expect(typeof result).toBe('string');
  });

  it('G3. [toggle-ON, fallback assembler] returns string', () => {
    setPromptAssemblyEnabled(true);
    const result = buildBlockAiSystemPrompt(MINIMAL_PARAMS, makeFallbackAssembler());
    expect(typeof result).toBe('string');
  });

  it('G4. [toggle-ON, assembler returning ""] returns empty string (never null)', () => {
    setPromptAssemblyEnabled(true);
    const emptyAssembler = vi.fn<[AssemblyRequest], AssembledPrompt>().mockReturnValue('');
    const result = buildBlockAiSystemPrompt(MINIMAL_PARAMS, emptyAssembler);

    expect(typeof result).toBe('string');
    expect(result).not.toBeNull();
    expect(result).not.toBeUndefined();
    expect(result).toBe('');
  });

  it('G5. return type is AssembledPrompt (a string alias)', () => {
    setPromptAssemblyEnabled(true);
    const result: string = buildBlockAiSystemPrompt(MINIMAL_PARAMS, makeFallbackAssembler());
    expect(typeof result).toBe('string');
  });
});
