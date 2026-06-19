/**
 * resolve-mentions.test.ts
 *
 * Unit tests for the `resolveMentions` Phase 1 stub
 * (src/main/prompts/resolve.ts).
 *
 * Sub-AC 7.2 requirements:
 *   ✓ `resolveMentions` is exported as a function
 *   ✓ `MENTIONS_STUB` is exported as the sentinel constant (frozen empty array)
 *   ✓ `MentionResolutionParams` type is exported (verified via TS usage)
 *   ✓ `MentionResolution` type is exported (verified via TS usage)
 *   ✓ Stub has the correct parameter signature ({ text: string })
 *   ✓ Stub returns the defined empty sentinel value (an empty array [])
 *   ✓ No @mention resolution logic is implemented — result is always []
 *   ✓ Never throws for any input
 *   ✓ Each call returns a new independent array (not the frozen MENTIONS_STUB reference)
 *
 * Test groups:
 *   A. Export surface — function and sentinel are exported
 *   B. MENTIONS_STUB sentinel structure
 *   C. resolveMentions return value
 *   D. Return value matches sentinel (empty array)
 *   E. No mention-resolution logic — result is always empty
 *   F. Never throws — graceful for all inputs
 *   G. Independence — each call returns a new mutable array
 *   H. Type-level assertions (runtime-checked via typeof / structure)
 */

import { describe, it, expect } from 'vitest';
import {
  resolveMentions,
  MENTIONS_STUB,
  type MentionResolutionParams,
  type MentionResolution,
} from '../../src/main/prompts/resolve';

// ---------------------------------------------------------------------------
// A. Export surface — function and sentinel are exported
// ---------------------------------------------------------------------------

describe('A. Export surface', () => {
  it('A1. resolveMentions is exported', () => {
    expect(resolveMentions).toBeDefined();
  });

  it('A2. resolveMentions is a function', () => {
    expect(typeof resolveMentions).toBe('function');
  });

  it('A3. MENTIONS_STUB is exported', () => {
    expect(MENTIONS_STUB).toBeDefined();
  });

  it('A4. MENTIONS_STUB is an array', () => {
    expect(Array.isArray(MENTIONS_STUB)).toBe(true);
  });

  it('A5. MentionResolutionParams type is usable (text field exists on call)', () => {
    // Verify the type by constructing a valid params object and calling the function.
    const params: MentionResolutionParams = { text: 'Hello @Overview' };
    expect(() => resolveMentions(params)).not.toThrow();
  });

  it('A6. MentionResolution type is usable (token + content fields are valid)', () => {
    // Verify the type by constructing an instance — Phase 1 never creates one,
    // but the type must be usable by call-sites.
    const item: MentionResolution = { token: '@Overview', content: '' };
    expect(item.token).toBe('@Overview');
    expect(item.content).toBe('');
  });
});

// ---------------------------------------------------------------------------
// B. MENTIONS_STUB sentinel structure
// ---------------------------------------------------------------------------

describe('B. MENTIONS_STUB sentinel structure', () => {
  it('B1. MENTIONS_STUB is an empty array', () => {
    expect(MENTIONS_STUB).toHaveLength(0);
  });

  it('B2. MENTIONS_STUB has length 0', () => {
    expect(MENTIONS_STUB.length).toBe(0);
  });

  it('B3. MENTIONS_STUB is frozen (immutable)', () => {
    expect(Object.isFrozen(MENTIONS_STUB)).toBe(true);
  });

  it('B4. MENTIONS_STUB deep-equals []', () => {
    expect(MENTIONS_STUB).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// C. resolveMentions return value
// ---------------------------------------------------------------------------

describe('C. resolveMentions return value', () => {
  const result = resolveMentions({ text: 'Some text with @mention' });

  it('C1. returns an array', () => {
    expect(Array.isArray(result)).toBe(true);
  });

  it('C2. returned array is empty', () => {
    expect(result).toHaveLength(0);
  });

  it('C3. returned array deep-equals []', () => {
    expect(result).toEqual([]);
  });

  it('C4. return type is MentionResolution[] (structurally an array)', () => {
    // TypeScript enforces the return type; runtime check confirms it is an array.
    const r: MentionResolution[] = resolveMentions({ text: 'test' });
    expect(Array.isArray(r)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// D. Return value matches MENTIONS_STUB sentinel (empty array)
// ---------------------------------------------------------------------------

describe('D. Return value matches MENTIONS_STUB sentinel', () => {
  it('D1. result deep-equals MENTIONS_STUB', () => {
    const result = resolveMentions({ text: '@foo @bar' });
    expect(result).toEqual(MENTIONS_STUB);
  });

  it('D2. result length equals MENTIONS_STUB length (both 0)', () => {
    const result = resolveMentions({ text: 'text' });
    expect(result.length).toBe(MENTIONS_STUB.length);
  });

  it('D3. result is not the frozen MENTIONS_STUB reference itself', () => {
    const result = resolveMentions({ text: 'text' });
    // Should be a new array, not the same frozen reference.
    expect(result).not.toBe(MENTIONS_STUB);
  });
});

// ---------------------------------------------------------------------------
// E. No mention-resolution logic — result is always empty
// ---------------------------------------------------------------------------

describe('E. No mention-resolution logic — result is always empty', () => {
  it('E1. text with no @mentions → empty array', () => {
    const result = resolveMentions({ text: 'Hello world, no mentions here.' });
    expect(result).toHaveLength(0);
  });

  it('E2. text with a single @mention → still empty (Phase 1 stub)', () => {
    const result = resolveMentions({ text: 'Please check @Overview for context.' });
    expect(result).toHaveLength(0);
  });

  it('E3. text with multiple @mentions → still empty (no resolution in Phase 1)', () => {
    const result = resolveMentions({
      text: 'See @README and @Overview and @Introduction.',
    });
    expect(result).toHaveLength(0);
  });

  it('E4. empty text → empty array', () => {
    const result = resolveMentions({ text: '' });
    expect(result).toHaveLength(0);
  });

  it('E5. text with only whitespace → empty array', () => {
    const result = resolveMentions({ text: '   \t\n  ' });
    expect(result).toHaveLength(0);
  });

  it('E6. text with Korean @mentions → empty array (no I/O attempted)', () => {
    const result = resolveMentions({ text: '내용을 확인하세요 @개요 @소개' });
    expect(result).toHaveLength(0);
  });

  it('E7. very long text with many @mentions → empty array', () => {
    const manyMentions = Array.from(
      { length: 100 },
      (_, i) => `@section${i}`,
    ).join(' ');
    const result = resolveMentions({ text: manyMentions });
    expect(result).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// F. Never throws — graceful for all inputs
// ---------------------------------------------------------------------------

describe('F. Never throws — graceful for any text input', () => {
  const cases: MentionResolutionParams[] = [
    { text: '' },
    { text: 'plain text, no mentions' },
    { text: '@Overview' },
    { text: '@file1 @file2 @file3' },
    { text: '한국어 텍스트 @개요' },
    { text: 'text with\nnewlines\n@mention\nhere' },
    { text: '@'.repeat(1000) },
    { text: '   ' },
  ];

  for (const params of cases) {
    it(`F. text="${params.text.slice(0, 40)}..." does not throw`, () => {
      expect(() => resolveMentions(params)).not.toThrow();
    });
  }
});

// ---------------------------------------------------------------------------
// G. Independence — each call returns a new mutable array
// ---------------------------------------------------------------------------

describe('G. Independence — each call returns a new array reference', () => {
  it('G1. two calls return different array references', () => {
    const r1 = resolveMentions({ text: '@foo' });
    const r2 = resolveMentions({ text: '@bar' });
    expect(r1).not.toBe(r2);
  });

  it('G2. two calls return structurally equal results (both [])', () => {
    const r1 = resolveMentions({ text: '@a' });
    const r2 = resolveMentions({ text: '@b' });
    expect(r1).toEqual(r2);
  });

  it('G3. result is not the frozen MENTIONS_STUB reference', () => {
    const result = resolveMentions({ text: 'text' });
    expect(result).not.toBe(MENTIONS_STUB);
  });

  it('G4. returned array is mutable (not frozen)', () => {
    const result = resolveMentions({ text: 'text' });
    // Should be able to push to the returned array without throwing.
    expect(() => {
      result.push({ token: '@test', content: 'test-content' });
    }).not.toThrow();
    // Confirm the push worked on the result but MENTIONS_STUB is unchanged.
    expect(result).toHaveLength(1);
    expect(MENTIONS_STUB).toHaveLength(0);
  });

  it('G5. mutating one returned array does not affect another', () => {
    const r1 = resolveMentions({ text: 'text' });
    const r2 = resolveMentions({ text: 'text' });
    r1.push({ token: '@mutated', content: 'mutated' });
    expect(r2).toHaveLength(0);
  });

  it('G6. mutating a returned array does not affect MENTIONS_STUB', () => {
    const result = resolveMentions({ text: 'text' });
    result.push({ token: '@x', content: 'x' });
    expect(MENTIONS_STUB).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// H. Type-level assertions (runtime-checked via typeof / structure)
// ---------------------------------------------------------------------------

describe('H. Type-level assertions — runtime-checked via structure', () => {
  it('H1. resolveMentions accepts exactly one argument of shape { text: string }', () => {
    const params: MentionResolutionParams = { text: 'test input' };
    expect(() => resolveMentions(params)).not.toThrow();
  });

  it('H2. return type is an Array (runtime)', () => {
    const result = resolveMentions({ text: 'hello' });
    expect(Array.isArray(result)).toBe(true);
  });

  it('H3. MENTIONS_STUB is assignable to ReadonlyArray<MentionResolution>', () => {
    // Structural check: the constant must behave as a readonly array.
    const stub: ReadonlyArray<MentionResolution> = MENTIONS_STUB;
    expect(stub.length).toBe(0);
  });

  it('H4. MentionResolution type has token and content fields', () => {
    // Verify the shape of MentionResolution by constructing a typed value.
    const resolution: MentionResolution = { token: '@Doc', content: 'document text' };
    expect(resolution).toHaveProperty('token');
    expect(resolution).toHaveProperty('content');
  });

  it('H5. MentionResolutionParams has a text field of type string', () => {
    const params: MentionResolutionParams = { text: 'some @mention text' };
    expect(typeof params.text).toBe('string');
  });

  it('H6. resolveMentions return is typed as MentionResolution[] (structural check)', () => {
    // Phase 2 will push MentionResolution objects into the returned array.
    // Verify the array type is compatible with that usage.
    const result: MentionResolution[] = resolveMentions({ text: 'test' });
    expect(result).toEqual([]);
  });
});
