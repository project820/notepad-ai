/**
 * toggle.test.ts
 *
 * Unit tests for the v1.1 prompt-stack feature toggle
 * (src/main/prompts/toggle.ts).
 *
 * Sub-AC 3.1 requirements:
 *   ✓ A single function/config accessor exposes the prompt-assembly toggle.
 *   ✓ The toggle defaults to off (false).
 *   ✓ The toggle can be set on (true).
 *   ✓ The toggle returns the correct boolean on each subsequent read.
 *
 * Test groups:
 *   A. Default state              — toggle is off (false) on module load
 *   B. Set to on                  — setPromptAssemblyEnabled(true)
 *   C. Set to off                 — setPromptAssemblyEnabled(false)
 *   D. PROMPT_ASSEMBLY_DEFAULT    — constant is exactly false
 *   E. Return type guarantees     — isPromptAssemblyEnabled always returns boolean
 *   F. Toggle sequence            — set on → off → on → off round-trips
 *   G. Multiple reads             — value is stable between writes
 *   H. resetPromptAssembly        — restores default for test isolation
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  isPromptAssemblyEnabled,
  setPromptAssemblyEnabled,
  resetPromptAssembly,
  PROMPT_ASSEMBLY_DEFAULT,
} from '../../src/main/prompts/toggle';

// ---------------------------------------------------------------------------
// Test isolation: reset the module-level toggle state before every test.
// ---------------------------------------------------------------------------

beforeEach(() => {
  resetPromptAssembly();
});

// ============================================================================
// A. Default state — toggle is off (false) on module load
// ============================================================================

describe('A. Default state — toggle is off by default', () => {
  it('A1. [default] isPromptAssemblyEnabled returns false on first call', () => {
    expect(isPromptAssemblyEnabled()).toBe(false);
  });

  it('A2. [default] isPromptAssemblyEnabled returns false after reset', () => {
    // Ensure reset leaves the toggle in the correct default state.
    resetPromptAssembly();
    expect(isPromptAssemblyEnabled()).toBe(false);
  });

  it('A3. [default] isPromptAssemblyEnabled returns false without any set call', () => {
    // No set call — pure cold-start state.
    const result = isPromptAssemblyEnabled();
    expect(result).toBe(false);
  });

  it('A4. [default] multiple reads of the default state all return false', () => {
    for (let i = 0; i < 5; i++) {
      expect(isPromptAssemblyEnabled()).toBe(false);
    }
  });

  it('A5. [default] default state matches PROMPT_ASSEMBLY_DEFAULT', () => {
    expect(isPromptAssemblyEnabled()).toBe(PROMPT_ASSEMBLY_DEFAULT);
  });
});

// ============================================================================
// B. Set to on — setPromptAssemblyEnabled(true) activates the feature
// ============================================================================

describe('B. Set to on — setPromptAssemblyEnabled(true)', () => {
  it('B1. [set-on] isPromptAssemblyEnabled returns true after setPromptAssemblyEnabled(true)', () => {
    setPromptAssemblyEnabled(true);
    expect(isPromptAssemblyEnabled()).toBe(true);
  });

  it('B2. [set-on] setting to true takes effect immediately on next read', () => {
    expect(isPromptAssemblyEnabled()).toBe(false); // default
    setPromptAssemblyEnabled(true);
    expect(isPromptAssemblyEnabled()).toBe(true);  // updated
  });

  it('B3. [set-on] multiple reads after set-on all return true', () => {
    setPromptAssemblyEnabled(true);
    for (let i = 0; i < 5; i++) {
      expect(isPromptAssemblyEnabled()).toBe(true);
    }
  });

  it('B4. [set-on] calling setPromptAssemblyEnabled(true) twice is idempotent', () => {
    setPromptAssemblyEnabled(true);
    setPromptAssemblyEnabled(true);
    expect(isPromptAssemblyEnabled()).toBe(true);
  });

  it('B5. [set-on] setting to true does not affect the PROMPT_ASSEMBLY_DEFAULT constant', () => {
    setPromptAssemblyEnabled(true);
    // The constant must remain false even though the runtime state is true.
    expect(PROMPT_ASSEMBLY_DEFAULT).toBe(false);
  });
});

// ============================================================================
// C. Set to off — setPromptAssemblyEnabled(false) deactivates the feature
// ============================================================================

describe('C. Set to off — setPromptAssemblyEnabled(false)', () => {
  it('C1. [set-off] isPromptAssemblyEnabled returns false after setPromptAssemblyEnabled(false)', () => {
    setPromptAssemblyEnabled(true);  // turn on first
    setPromptAssemblyEnabled(false); // then turn off
    expect(isPromptAssemblyEnabled()).toBe(false);
  });

  it('C2. [set-off] setting to false from default is a no-op (still false)', () => {
    // Already false — explicit false should keep it false.
    setPromptAssemblyEnabled(false);
    expect(isPromptAssemblyEnabled()).toBe(false);
  });

  it('C3. [set-off] calling setPromptAssemblyEnabled(false) twice is idempotent', () => {
    setPromptAssemblyEnabled(true);
    setPromptAssemblyEnabled(false);
    setPromptAssemblyEnabled(false);
    expect(isPromptAssemblyEnabled()).toBe(false);
  });

  it('C4. [set-off] multiple reads after set-off all return false', () => {
    setPromptAssemblyEnabled(true);
    setPromptAssemblyEnabled(false);
    for (let i = 0; i < 5; i++) {
      expect(isPromptAssemblyEnabled()).toBe(false);
    }
  });

  it('C5. [set-off] return value is strict boolean false (not falsy)', () => {
    setPromptAssemblyEnabled(true);
    setPromptAssemblyEnabled(false);
    const result = isPromptAssemblyEnabled();
    expect(result).toBe(false);
    expect(result === false).toBe(true);
  });
});

// ============================================================================
// D. PROMPT_ASSEMBLY_DEFAULT — the exported constant is exactly false
// ============================================================================

describe('D. PROMPT_ASSEMBLY_DEFAULT — constant is exactly false', () => {
  it('D1. PROMPT_ASSEMBLY_DEFAULT is the boolean false', () => {
    expect(PROMPT_ASSEMBLY_DEFAULT).toBe(false);
  });

  it('D2. PROMPT_ASSEMBLY_DEFAULT is a boolean (not 0, null, undefined, or "")', () => {
    expect(typeof PROMPT_ASSEMBLY_DEFAULT).toBe('boolean');
  });

  it('D3. PROMPT_ASSEMBLY_DEFAULT equals the initial return value of isPromptAssemblyEnabled', () => {
    expect(isPromptAssemblyEnabled()).toBe(PROMPT_ASSEMBLY_DEFAULT);
  });

  it('D4. PROMPT_ASSEMBLY_DEFAULT is stable (same value on multiple accesses)', () => {
    const first = PROMPT_ASSEMBLY_DEFAULT;
    const second = PROMPT_ASSEMBLY_DEFAULT;
    expect(first).toBe(second);
    expect(first).toBe(false);
  });

  it('D5. PROMPT_ASSEMBLY_DEFAULT is not affected by toggle state changes', () => {
    setPromptAssemblyEnabled(true);
    expect(PROMPT_ASSEMBLY_DEFAULT).toBe(false); // constant unchanged

    setPromptAssemblyEnabled(false);
    expect(PROMPT_ASSEMBLY_DEFAULT).toBe(false); // still unchanged
  });
});

// ============================================================================
// E. Return type guarantees — isPromptAssemblyEnabled always returns boolean
// ============================================================================

describe('E. Return type guarantees', () => {
  it('E1. return type is boolean in default state', () => {
    const result = isPromptAssemblyEnabled();
    expect(typeof result).toBe('boolean');
  });

  it('E2. return type is boolean after set-on', () => {
    setPromptAssemblyEnabled(true);
    const result = isPromptAssemblyEnabled();
    expect(typeof result).toBe('boolean');
  });

  it('E3. return type is boolean after set-off', () => {
    setPromptAssemblyEnabled(true);
    setPromptAssemblyEnabled(false);
    const result = isPromptAssemblyEnabled();
    expect(typeof result).toBe('boolean');
  });

  it('E4. isPromptAssemblyEnabled returns true (strict) when enabled', () => {
    setPromptAssemblyEnabled(true);
    const result = isPromptAssemblyEnabled();
    expect(result === true).toBe(true);
  });

  it('E5. isPromptAssemblyEnabled returns false (strict) when disabled', () => {
    const result = isPromptAssemblyEnabled();
    expect(result === false).toBe(true);
  });

  it('E6. setPromptAssemblyEnabled returns void (undefined)', () => {
    const result = setPromptAssemblyEnabled(true);
    expect(result).toBeUndefined();
  });

  it('E7. resetPromptAssembly returns void (undefined)', () => {
    const result = resetPromptAssembly();
    expect(result).toBeUndefined();
  });
});

// ============================================================================
// F. Toggle sequence — round-trip set on → off → on
// ============================================================================

describe('F. Toggle sequence — on/off round-trips', () => {
  it('F1. default → on → off yields false', () => {
    // default
    expect(isPromptAssemblyEnabled()).toBe(false);
    // set on
    setPromptAssemblyEnabled(true);
    expect(isPromptAssemblyEnabled()).toBe(true);
    // set off
    setPromptAssemblyEnabled(false);
    expect(isPromptAssemblyEnabled()).toBe(false);
  });

  it('F2. default → on → off → on yields true', () => {
    setPromptAssemblyEnabled(true);
    setPromptAssemblyEnabled(false);
    setPromptAssemblyEnabled(true);
    expect(isPromptAssemblyEnabled()).toBe(true);
  });

  it('F3. five rapid toggles end in the correct final state (true)', () => {
    // odd number of toggles from false → final state is true
    for (let i = 0; i < 5; i++) {
      setPromptAssemblyEnabled(i % 2 === 0); // T,F,T,F,T — ends at true (i=4, 4%2=0, true)
    }
    expect(isPromptAssemblyEnabled()).toBe(true);
  });

  it('F4. six rapid toggles end in the correct final state (false)', () => {
    // Sequence: T,F,T,F,T,F — ends at false
    for (let i = 0; i < 6; i++) {
      setPromptAssemblyEnabled(i % 2 === 0); // i=5 → 5%2=1 → false
    }
    expect(isPromptAssemblyEnabled()).toBe(false);
  });

  it('F5. each read between toggles reflects the current state correctly', () => {
    const states = [true, false, true, false, true];
    for (const state of states) {
      setPromptAssemblyEnabled(state);
      expect(isPromptAssemblyEnabled()).toBe(state);
    }
  });
});

// ============================================================================
// G. Multiple reads — value is stable between explicit writes
// ============================================================================

describe('G. Multiple reads — value is stable between writes', () => {
  it('G1. reading 10 times in a row with no write always returns the same value (false)', () => {
    const results = Array.from({ length: 10 }, () => isPromptAssemblyEnabled());
    expect(results.every((r) => r === false)).toBe(true);
  });

  it('G2. reading 10 times in a row with no write always returns the same value (true)', () => {
    setPromptAssemblyEnabled(true);
    const results = Array.from({ length: 10 }, () => isPromptAssemblyEnabled());
    expect(results.every((r) => r === true)).toBe(true);
  });

  it('G3. isPromptAssemblyEnabled is a pure read — it never changes state on its own', () => {
    // Calling the read function should not mutate the internal state.
    isPromptAssemblyEnabled();
    isPromptAssemblyEnabled();
    isPromptAssemblyEnabled();
    expect(isPromptAssemblyEnabled()).toBe(false); // still default
  });

  it('G4. toggle state is not affected by calling reset after set-on when reading', () => {
    setPromptAssemblyEnabled(true);
    const before = isPromptAssemblyEnabled(); // true
    resetPromptAssembly();
    const after = isPromptAssemblyEnabled();  // false (reset)
    expect(before).toBe(true);
    expect(after).toBe(false);
  });
});

// ============================================================================
// H. resetPromptAssembly — restores default for test isolation
// ============================================================================

describe('H. resetPromptAssembly — restores default state', () => {
  it('H1. reset after set-on returns toggle to false', () => {
    setPromptAssemblyEnabled(true);
    resetPromptAssembly();
    expect(isPromptAssemblyEnabled()).toBe(false);
  });

  it('H2. reset after set-off is a no-op (remains false)', () => {
    setPromptAssemblyEnabled(false);
    resetPromptAssembly();
    expect(isPromptAssemblyEnabled()).toBe(false);
  });

  it('H3. double reset is idempotent', () => {
    setPromptAssemblyEnabled(true);
    resetPromptAssembly();
    resetPromptAssembly();
    expect(isPromptAssemblyEnabled()).toBe(false);
  });

  it('H4. reset restores the value that matches PROMPT_ASSEMBLY_DEFAULT', () => {
    setPromptAssemblyEnabled(true);
    resetPromptAssembly();
    expect(isPromptAssemblyEnabled()).toBe(PROMPT_ASSEMBLY_DEFAULT);
  });

  it('H5. state set after reset is respected normally', () => {
    setPromptAssemblyEnabled(true);
    resetPromptAssembly();
    setPromptAssemblyEnabled(true);
    expect(isPromptAssemblyEnabled()).toBe(true);
  });

  it('H6. reset returns void (undefined)', () => {
    const result = resetPromptAssembly();
    expect(result).toBeUndefined();
  });
});
