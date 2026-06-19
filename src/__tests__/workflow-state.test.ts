/**
 * workflow-state.test.ts
 *
 * Unit tests for the two workflow state factory functions:
 *   - buildTriggerOutlineToDraftState(payload) → TriggerOutlineToDraftState
 *   - buildNoOpState()                          → NoOpState
 *
 * Sub-AC 6d-i requirements:
 *   ✓ Each constructor's output shape (correct fields, correct types)
 *   ✓ Discriminated union tag (type field is the correct literal)
 *   ✓ Immutability — mutation attempts throw TypeError in strict mode (ESM)
 *     or are silently ignored in non-strict mode (Object.freeze guarantee)
 *
 * Test groups:
 *   A. buildTriggerOutlineToDraftState — type discriminant
 *   B. buildTriggerOutlineToDraftState — required fields present
 *   C. buildTriggerOutlineToDraftState — payload field propagation
 *   D. buildTriggerOutlineToDraftState — triggeredAt defaulting behaviour
 *   E. buildTriggerOutlineToDraftState — signals array handling
 *   F. buildTriggerOutlineToDraftState — immutability (Object.freeze)
 *   G. buildNoOpState                  — type discriminant
 *   H. buildNoOpState                  — output shape (no extra fields)
 *   I. buildNoOpState                  — immutability (Object.freeze)
 *   J. WorkflowState discriminated union — type narrowing
 *   K. Constructor independence         — each constructor works independently
 *   L. TypeScript structural conformance — interfaces match runtime shapes
 *   M. Edge cases                       — boundary values, empty inputs
 */

import { describe, it, expect } from 'vitest';
import {
  buildTriggerOutlineToDraftState,
  buildNoOpState,
  type TriggerOutlineToDraftState,
  type NoOpState,
  type WorkflowState,
  type TriggerOutlineToDraftPayload,
} from '../renderer/workflow-state';

// ---------------------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------------------

/**
 * Minimal valid TriggerOutlineToDraftPayload with all required fields.
 * Override individual fields via the `overrides` parameter.
 */
function basePayload(
  overrides: Partial<TriggerOutlineToDraftPayload> = {},
): TriggerOutlineToDraftPayload {
  return {
    userMessage: 'Please draft each section',
    confidence: 0.9,
    signals: ['exact_trigger'],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// A. buildTriggerOutlineToDraftState — type discriminant
// ---------------------------------------------------------------------------

describe('buildTriggerOutlineToDraftState — type discriminant', () => {
  it('returns an object with type === "trigger_outline_to_draft"', () => {
    const state = buildTriggerOutlineToDraftState(basePayload());
    expect(state.type).toBe('trigger_outline_to_draft');
  });

  it('type field is the string literal, not any other value', () => {
    const state = buildTriggerOutlineToDraftState(basePayload());
    expect(state.type).not.toBe('noop');
    expect(state.type).not.toBe('normal_response');
    expect(state.type).not.toBe('confirmation_card');
    expect(state.type).not.toBe('');
  });

  it('type field is a string', () => {
    const state = buildTriggerOutlineToDraftState(basePayload());
    expect(typeof state.type).toBe('string');
  });

  it('type field is identical across multiple calls with same payload', () => {
    const a = buildTriggerOutlineToDraftState(basePayload());
    const b = buildTriggerOutlineToDraftState(basePayload());
    expect(a.type).toBe(b.type);
    expect(a.type).toBe('trigger_outline_to_draft');
  });

  it('type field is stable regardless of payload content variations', () => {
    const withHighConfidence = buildTriggerOutlineToDraftState(
      basePayload({ confidence: 1.0 }),
    );
    const withLowConfidence = buildTriggerOutlineToDraftState(
      basePayload({ confidence: 0.6 }),
    );
    expect(withHighConfidence.type).toBe('trigger_outline_to_draft');
    expect(withLowConfidence.type).toBe('trigger_outline_to_draft');
  });

  it('type field is stable for minimal payload (required fields only)', () => {
    const state = buildTriggerOutlineToDraftState({
      userMessage: 'draft now',
      confidence: 0.9,
      signals: [],
    });
    expect(state.type).toBe('trigger_outline_to_draft');
  });
});

// ---------------------------------------------------------------------------
// B. buildTriggerOutlineToDraftState — required fields present
// ---------------------------------------------------------------------------

describe('buildTriggerOutlineToDraftState — required fields present', () => {
  it('returned state has a "type" field', () => {
    const state = buildTriggerOutlineToDraftState(basePayload());
    expect('type' in state).toBe(true);
  });

  it('returned state has a "userMessage" field', () => {
    const state = buildTriggerOutlineToDraftState(basePayload());
    expect('userMessage' in state).toBe(true);
  });

  it('returned state has a "confidence" field', () => {
    const state = buildTriggerOutlineToDraftState(basePayload());
    expect('confidence' in state).toBe(true);
  });

  it('returned state has a "signals" field', () => {
    const state = buildTriggerOutlineToDraftState(basePayload());
    expect('signals' in state).toBe(true);
  });

  it('returned state has a "triggeredAt" field', () => {
    const state = buildTriggerOutlineToDraftState(basePayload());
    expect('triggeredAt' in state).toBe(true);
  });

  it('returned state has exactly the expected top-level keys', () => {
    const state = buildTriggerOutlineToDraftState(basePayload());
    const keys = Object.keys(state).sort();
    expect(keys).toEqual(
      ['type', 'userMessage', 'confidence', 'signals', 'triggeredAt'].sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// C. buildTriggerOutlineToDraftState — payload field propagation
// ---------------------------------------------------------------------------

describe('buildTriggerOutlineToDraftState — payload field propagation', () => {
  it('userMessage equals the payload userMessage', () => {
    const msg = 'Draft each section of the document please';
    const state = buildTriggerOutlineToDraftState(basePayload({ userMessage: msg }));
    expect(state.userMessage).toBe(msg);
  });

  it('userMessage is preserved verbatim (no trimming or modification)', () => {
    const msg = '  padded message  ';
    const state = buildTriggerOutlineToDraftState(basePayload({ userMessage: msg }));
    expect(state.userMessage).toBe(msg);
  });

  it('userMessage is preserved for Korean text', () => {
    const msg = '각 섹션을 작성해줘';
    const state = buildTriggerOutlineToDraftState(basePayload({ userMessage: msg }));
    expect(state.userMessage).toBe(msg);
  });

  it('confidence equals the payload confidence', () => {
    const state = buildTriggerOutlineToDraftState(basePayload({ confidence: 0.75 }));
    expect(state.confidence).toBe(0.75);
  });

  it('confidence equals 0.6 (threshold boundary)', () => {
    const state = buildTriggerOutlineToDraftState(basePayload({ confidence: 0.6 }));
    expect(state.confidence).toBe(0.6);
  });

  it('confidence equals 1.0 (maximum)', () => {
    const state = buildTriggerOutlineToDraftState(basePayload({ confidence: 1.0 }));
    expect(state.confidence).toBe(1.0);
  });

  it('signals deep-equals the payload signals array', () => {
    const signals = ['exact_trigger', 'section_scope_en'];
    const state = buildTriggerOutlineToDraftState(basePayload({ signals }));
    expect(Array.from(state.signals)).toEqual(signals);
  });

  it('signals order is preserved', () => {
    const signals = ['draft_verb_en', 'section_scope_en', 'negation_halved'];
    const state = buildTriggerOutlineToDraftState(basePayload({ signals }));
    expect(Array.from(state.signals)).toEqual(signals);
  });

  it('triggeredAt equals the explicit value when provided', () => {
    const ts = 1700000000000;
    const state = buildTriggerOutlineToDraftState(basePayload({ triggeredAt: ts }));
    expect(state.triggeredAt).toBe(ts);
  });
});

// ---------------------------------------------------------------------------
// D. buildTriggerOutlineToDraftState — triggeredAt defaulting behaviour
// ---------------------------------------------------------------------------

describe('buildTriggerOutlineToDraftState — triggeredAt default', () => {
  it('triggeredAt is a number when payload omits triggeredAt', () => {
    const state = buildTriggerOutlineToDraftState(basePayload());
    expect(typeof state.triggeredAt).toBe('number');
  });

  it('triggeredAt is a positive integer (Unix ms) when omitted from payload', () => {
    const before = Date.now();
    const state = buildTriggerOutlineToDraftState(basePayload());
    const after = Date.now();
    expect(state.triggeredAt).toBeGreaterThanOrEqual(before);
    expect(state.triggeredAt).toBeLessThanOrEqual(after);
  });

  it('triggeredAt is not NaN when omitted from payload', () => {
    const state = buildTriggerOutlineToDraftState(basePayload());
    expect(Number.isNaN(state.triggeredAt)).toBe(false);
  });

  it('triggeredAt equals explicit payload value even when zero', () => {
    const state = buildTriggerOutlineToDraftState(basePayload({ triggeredAt: 0 }));
    expect(state.triggeredAt).toBe(0);
  });

  it('triggeredAt equals explicit payload value for large timestamps', () => {
    const ts = Number.MAX_SAFE_INTEGER;
    const state = buildTriggerOutlineToDraftState(basePayload({ triggeredAt: ts }));
    expect(state.triggeredAt).toBe(ts);
  });

  it('two calls without explicit triggeredAt produce non-decreasing timestamps', () => {
    const a = buildTriggerOutlineToDraftState(basePayload());
    const b = buildTriggerOutlineToDraftState(basePayload());
    expect(b.triggeredAt).toBeGreaterThanOrEqual(a.triggeredAt);
  });
});

// ---------------------------------------------------------------------------
// E. buildTriggerOutlineToDraftState — signals array handling
// ---------------------------------------------------------------------------

describe('buildTriggerOutlineToDraftState — signals array handling', () => {
  it('signals is an array-like object', () => {
    const state = buildTriggerOutlineToDraftState(basePayload());
    expect(Array.isArray(state.signals) || typeof (state.signals as unknown as { length: number }).length === 'number').toBe(true);
  });

  it('signals length equals the payload signals length', () => {
    const state = buildTriggerOutlineToDraftState(basePayload({ signals: ['a', 'b', 'c'] }));
    expect(state.signals.length).toBe(3);
  });

  it('signals is empty when payload signals is empty', () => {
    const state = buildTriggerOutlineToDraftState(basePayload({ signals: [] }));
    expect(state.signals.length).toBe(0);
  });

  it('signals elements match payload elements by value', () => {
    const signals = ['exact_trigger', 'section_scope_ko'];
    const state = buildTriggerOutlineToDraftState(basePayload({ signals }));
    expect(state.signals[0]).toBe('exact_trigger');
    expect(state.signals[1]).toBe('section_scope_ko');
  });

  it('mutating the original payload signals array does not affect state.signals', () => {
    const signals = ['original'];
    const state = buildTriggerOutlineToDraftState(basePayload({ signals }));
    signals.push('mutated');
    // state.signals should not contain 'mutated' — it was copied at construction
    expect(Array.from(state.signals)).not.toContain('mutated');
    expect(Array.from(state.signals)).toEqual(['original']);
  });

  it('state.signals is a frozen array (Object.isFrozen)', () => {
    const state = buildTriggerOutlineToDraftState(basePayload({ signals: ['s1'] }));
    expect(Object.isFrozen(state.signals)).toBe(true);
  });

  it('pushing to state.signals throws TypeError (strict mode / ESM)', () => {
    const state = buildTriggerOutlineToDraftState(basePayload({ signals: ['s1'] }));
    expect(() => {
      (state.signals as string[]).push('new_signal');
    }).toThrow(TypeError);
  });

  it('replacing a signals element throws TypeError (strict mode / ESM)', () => {
    const state = buildTriggerOutlineToDraftState(basePayload({ signals: ['s1'] }));
    expect(() => {
      (state.signals as string[])[0] = 'hacked';
    }).toThrow(TypeError);
  });
});

// ---------------------------------------------------------------------------
// F. buildTriggerOutlineToDraftState — immutability (Object.freeze)
// ---------------------------------------------------------------------------

describe('buildTriggerOutlineToDraftState — immutability', () => {
  it('returned object is frozen (Object.isFrozen)', () => {
    const state = buildTriggerOutlineToDraftState(basePayload());
    expect(Object.isFrozen(state)).toBe(true);
  });

  it('assigning to state.type throws TypeError in strict mode', () => {
    const state = buildTriggerOutlineToDraftState(basePayload());
    expect(() => {
      // @ts-expect-error: intentionally mutating a readonly frozen field
      state.type = 'noop';
    }).toThrow(TypeError);
  });

  it('assigning to state.userMessage throws TypeError in strict mode', () => {
    const state = buildTriggerOutlineToDraftState(basePayload());
    expect(() => {
      // @ts-expect-error: intentionally mutating a readonly frozen field
      state.userMessage = 'hacked';
    }).toThrow(TypeError);
  });

  it('assigning to state.confidence throws TypeError in strict mode', () => {
    const state = buildTriggerOutlineToDraftState(basePayload());
    expect(() => {
      // @ts-expect-error: intentionally mutating a readonly frozen field
      state.confidence = 0;
    }).toThrow(TypeError);
  });

  it('assigning to state.signals throws TypeError in strict mode', () => {
    const state = buildTriggerOutlineToDraftState(basePayload());
    expect(() => {
      // @ts-expect-error: intentionally mutating a readonly frozen field
      state.signals = [];
    }).toThrow(TypeError);
  });

  it('assigning to state.triggeredAt throws TypeError in strict mode', () => {
    const state = buildTriggerOutlineToDraftState(basePayload());
    expect(() => {
      // @ts-expect-error: intentionally mutating a readonly frozen field
      state.triggeredAt = 0;
    }).toThrow(TypeError);
  });

  it('adding a new property to the state throws TypeError in strict mode', () => {
    const state = buildTriggerOutlineToDraftState(basePayload());
    expect(() => {
      (state as Record<string, unknown>)['extra'] = 'value';
    }).toThrow(TypeError);
  });

  it('deleting a property from the state throws TypeError in strict mode', () => {
    const state = buildTriggerOutlineToDraftState(basePayload());
    expect(() => {
      // @ts-expect-error: intentionally deleting a property from frozen object
      delete (state as Record<string, unknown>)['type'];
    }).toThrow(TypeError);
  });

  it('each call returns a distinct frozen object (not the same reference)', () => {
    const a = buildTriggerOutlineToDraftState(basePayload());
    const b = buildTriggerOutlineToDraftState(basePayload());
    expect(a).not.toBe(b);
    expect(Object.isFrozen(a)).toBe(true);
    expect(Object.isFrozen(b)).toBe(true);
  });

  it('state values are correctly preserved despite being frozen', () => {
    const state = buildTriggerOutlineToDraftState(
      basePayload({ userMessage: 'draft', confidence: 0.85, signals: ['s1', 's2'] }),
    );
    // Values accessible and correct even after freeze
    expect(state.type).toBe('trigger_outline_to_draft');
    expect(state.userMessage).toBe('draft');
    expect(state.confidence).toBe(0.85);
    expect(Array.from(state.signals)).toEqual(['s1', 's2']);
    expect(typeof state.triggeredAt).toBe('number');
  });
});

// ---------------------------------------------------------------------------
// G. buildNoOpState — type discriminant
// ---------------------------------------------------------------------------

describe('buildNoOpState — type discriminant', () => {
  it('returns an object with type === "noop"', () => {
    const state = buildNoOpState();
    expect(state.type).toBe('noop');
  });

  it('type field is the string literal "noop", not any other value', () => {
    const state = buildNoOpState();
    expect(state.type).not.toBe('trigger_outline_to_draft');
    expect(state.type).not.toBe('normal_response');
    expect(state.type).not.toBe('confirmation_card');
    expect(state.type).not.toBe('');
  });

  it('type field is a string', () => {
    const state = buildNoOpState();
    expect(typeof state.type).toBe('string');
  });

  it('type field is identical across multiple calls', () => {
    const a = buildNoOpState();
    const b = buildNoOpState();
    expect(a.type).toBe(b.type);
    expect(a.type).toBe('noop');
  });
});

// ---------------------------------------------------------------------------
// H. buildNoOpState — output shape (no extra fields)
// ---------------------------------------------------------------------------

describe('buildNoOpState — output shape', () => {
  it('returned state has a "type" field', () => {
    const state = buildNoOpState();
    expect('type' in state).toBe(true);
  });

  it('returned state has exactly one top-level key: "type"', () => {
    const state = buildNoOpState();
    const keys = Object.keys(state);
    expect(keys).toEqual(['type']);
  });

  it('state does not have a "userMessage" field', () => {
    const state = buildNoOpState() as Record<string, unknown>;
    expect('userMessage' in state).toBe(false);
  });

  it('state does not have a "confidence" field', () => {
    const state = buildNoOpState() as Record<string, unknown>;
    expect('confidence' in state).toBe(false);
  });

  it('state does not have a "signals" field', () => {
    const state = buildNoOpState() as Record<string, unknown>;
    expect('signals' in state).toBe(false);
  });

  it('state does not have a "triggeredAt" field', () => {
    const state = buildNoOpState() as Record<string, unknown>;
    expect('triggeredAt' in state).toBe(false);
  });

  it('each call returns a distinct object (not the same reference)', () => {
    const a = buildNoOpState();
    const b = buildNoOpState();
    expect(a).not.toBe(b);
  });

  it('state values are structurally equal across calls', () => {
    const a = buildNoOpState();
    const b = buildNoOpState();
    expect(a).toEqual(b);
  });
});

// ---------------------------------------------------------------------------
// I. buildNoOpState — immutability (Object.freeze)
// ---------------------------------------------------------------------------

describe('buildNoOpState — immutability', () => {
  it('returned object is frozen (Object.isFrozen)', () => {
    const state = buildNoOpState();
    expect(Object.isFrozen(state)).toBe(true);
  });

  it('assigning to state.type throws TypeError in strict mode', () => {
    const state = buildNoOpState();
    expect(() => {
      // @ts-expect-error: intentionally mutating a readonly frozen field
      state.type = 'trigger_outline_to_draft';
    }).toThrow(TypeError);
  });

  it('adding a new property to the state throws TypeError in strict mode', () => {
    const state = buildNoOpState();
    expect(() => {
      (state as Record<string, unknown>)['extra'] = 'value';
    }).toThrow(TypeError);
  });

  it('deleting the type property throws TypeError in strict mode', () => {
    const state = buildNoOpState();
    expect(() => {
      // @ts-expect-error: intentionally deleting a property from frozen object
      delete (state as Record<string, unknown>)['type'];
    }).toThrow(TypeError);
  });

  it('type value is accessible and correct despite being frozen', () => {
    const state = buildNoOpState();
    expect(state.type).toBe('noop');
  });

  it('each call returns a distinct frozen object', () => {
    const a = buildNoOpState();
    const b = buildNoOpState();
    expect(a).not.toBe(b);
    expect(Object.isFrozen(a)).toBe(true);
    expect(Object.isFrozen(b)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// J. WorkflowState discriminated union — type narrowing
// ---------------------------------------------------------------------------

describe('WorkflowState discriminated union — type narrowing', () => {
  it('narrowing to "trigger_outline_to_draft" gives access to payload fields', () => {
    const state: WorkflowState = buildTriggerOutlineToDraftState(basePayload());
    if (state.type === 'trigger_outline_to_draft') {
      // TypeScript narrows to TriggerOutlineToDraftState here
      expect(state.userMessage).toBeDefined();
      expect(typeof state.confidence).toBe('number');
      expect(typeof state.triggeredAt).toBe('number');
    } else {
      throw new Error('Expected trigger_outline_to_draft state');
    }
  });

  it('narrowing to "noop" restricts access to just the type field', () => {
    const state: WorkflowState = buildNoOpState();
    if (state.type === 'noop') {
      // TypeScript narrows to NoOpState here — only type is accessible
      expect(state.type).toBe('noop');
    } else {
      throw new Error('Expected noop state');
    }
  });

  it('switch statement can exhaust all WorkflowState types without default branch', () => {
    function describeState(state: WorkflowState): string {
      switch (state.type) {
        case 'trigger_outline_to_draft':
          return `draft:${state.userMessage}`;
        case 'noop':
          return 'noop';
      }
    }

    const triggerState: WorkflowState = buildTriggerOutlineToDraftState(
      basePayload({ userMessage: 'draft please' }),
    );
    const noopState: WorkflowState = buildNoOpState();

    expect(describeState(triggerState)).toBe('draft:draft please');
    expect(describeState(noopState)).toBe('noop');
  });

  it('trigger state does NOT have fields from NoOpState that are absent on that interface', () => {
    // TriggerOutlineToDraftState has userMessage, NoOpState does not
    const noopState = buildNoOpState() as Record<string, unknown>;
    expect('userMessage' in noopState).toBe(false);
  });

  it('noop state does NOT have fields exclusive to TriggerOutlineToDraftState', () => {
    const noopState = buildNoOpState() as Record<string, unknown>;
    expect('confidence' in noopState).toBe(false);
    expect('signals' in noopState).toBe(false);
    expect('triggeredAt' in noopState).toBe(false);
  });

  it('WorkflowState array can hold both state variants', () => {
    const states: WorkflowState[] = [
      buildTriggerOutlineToDraftState(basePayload()),
      buildNoOpState(),
    ];
    expect(states[0].type).toBe('trigger_outline_to_draft');
    expect(states[1].type).toBe('noop');
  });

  it('buildTriggerOutlineToDraftState return is assignable to WorkflowState', () => {
    const state: WorkflowState = buildTriggerOutlineToDraftState(basePayload());
    expect(state.type).toBe('trigger_outline_to_draft');
  });

  it('buildNoOpState return is assignable to WorkflowState', () => {
    const state: WorkflowState = buildNoOpState();
    expect(state.type).toBe('noop');
  });
});

// ---------------------------------------------------------------------------
// K. Constructor independence — each constructor works independently
// ---------------------------------------------------------------------------

describe('Constructor independence', () => {
  it('calling buildNoOpState does not affect subsequent buildTriggerOutlineToDraftState calls', () => {
    buildNoOpState();
    const state = buildTriggerOutlineToDraftState(basePayload({ confidence: 0.88 }));
    expect(state.type).toBe('trigger_outline_to_draft');
    expect(state.confidence).toBe(0.88);
  });

  it('calling buildTriggerOutlineToDraftState does not affect subsequent buildNoOpState calls', () => {
    buildTriggerOutlineToDraftState(basePayload());
    const state = buildNoOpState();
    expect(state.type).toBe('noop');
  });

  it('interleaved calls produce independent results', () => {
    const s1 = buildNoOpState();
    const s2 = buildTriggerOutlineToDraftState(basePayload({ confidence: 0.9 }));
    const s3 = buildNoOpState();
    const s4 = buildTriggerOutlineToDraftState(basePayload({ confidence: 0.7 }));

    expect(s1.type).toBe('noop');
    expect(s2.type).toBe('trigger_outline_to_draft');
    expect(s3.type).toBe('noop');
    expect(s4.type).toBe('trigger_outline_to_draft');

    if (s2.type === 'trigger_outline_to_draft') {
      expect(s2.confidence).toBe(0.9);
    }
    if (s4.type === 'trigger_outline_to_draft') {
      expect(s4.confidence).toBe(0.7);
    }
  });

  it('buildNoOpState returns a new distinct object each call', () => {
    const a = buildNoOpState();
    const b = buildNoOpState();
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });

  it('buildTriggerOutlineToDraftState returns a new distinct object each call', () => {
    const a = buildTriggerOutlineToDraftState(basePayload());
    const b = buildTriggerOutlineToDraftState(basePayload());
    expect(a).not.toBe(b);
    expect(a.type).toBe(b.type);
  });
});

// ---------------------------------------------------------------------------
// L. TypeScript structural conformance — interfaces match runtime shapes
// ---------------------------------------------------------------------------

describe('TypeScript structural conformance', () => {
  it('TriggerOutlineToDraftState interface: typed variable has expected property types', () => {
    const state: TriggerOutlineToDraftState = buildTriggerOutlineToDraftState(
      basePayload({ language: undefined } as Partial<TriggerOutlineToDraftPayload>),
    );
    expect(typeof state.type).toBe('string');
    expect(state.type).toBe('trigger_outline_to_draft');
    expect(typeof state.userMessage).toBe('string');
    expect(typeof state.confidence).toBe('number');
    expect(typeof state.triggeredAt).toBe('number');
    expect(typeof state.signals.length).toBe('number');
  });

  it('NoOpState interface: typed variable has expected property types', () => {
    const state: NoOpState = buildNoOpState();
    expect(typeof state.type).toBe('string');
    expect(state.type).toBe('noop');
  });

  it('TriggerOutlineToDraftPayload: typed variable conforms to structural requirements', () => {
    const payload: TriggerOutlineToDraftPayload = {
      userMessage: 'fill in sections',
      confidence: 0.95,
      signals: ['exact_trigger', 'section_scope_en'],
      triggeredAt: 1700000000000,
    };
    const state = buildTriggerOutlineToDraftState(payload);
    expect(state.type).toBe('trigger_outline_to_draft');
    expect(state.triggeredAt).toBe(1700000000000);
  });

  it('WorkflowState type: holds both state variants', () => {
    const states: WorkflowState[] = [
      buildTriggerOutlineToDraftState(basePayload()),
      buildNoOpState(),
    ];
    expect(states[0].type).toBe('trigger_outline_to_draft');
    expect(states[1].type).toBe('noop');
  });
});

// ---------------------------------------------------------------------------
// M. Edge cases — boundary values, empty inputs
// ---------------------------------------------------------------------------

describe('Edge cases', () => {
  it('empty userMessage is accepted without crash', () => {
    expect(() =>
      buildTriggerOutlineToDraftState(basePayload({ userMessage: '' })),
    ).not.toThrow();
    const state = buildTriggerOutlineToDraftState(basePayload({ userMessage: '' }));
    expect(state.userMessage).toBe('');
  });

  it('empty signals array is accepted without crash', () => {
    expect(() =>
      buildTriggerOutlineToDraftState(basePayload({ signals: [] })),
    ).not.toThrow();
    const state = buildTriggerOutlineToDraftState(basePayload({ signals: [] }));
    expect(state.signals.length).toBe(0);
  });

  it('confidence = 0 is accepted', () => {
    const state = buildTriggerOutlineToDraftState(basePayload({ confidence: 0 }));
    expect(state.confidence).toBe(0);
  });

  it('confidence = 1 is accepted', () => {
    const state = buildTriggerOutlineToDraftState(basePayload({ confidence: 1 }));
    expect(state.confidence).toBe(1);
  });

  it('very long userMessage is preserved without truncation', () => {
    const long = 'a'.repeat(10_000);
    const state = buildTriggerOutlineToDraftState(basePayload({ userMessage: long }));
    expect(state.userMessage.length).toBe(10_000);
    expect(state.userMessage).toBe(long);
  });

  it('large signals array (100 elements) is handled correctly', () => {
    const signals = Array.from({ length: 100 }, (_, i) => `signal_${i}`);
    const state = buildTriggerOutlineToDraftState(basePayload({ signals }));
    expect(state.signals.length).toBe(100);
    expect(state.signals[0]).toBe('signal_0');
    expect(state.signals[99]).toBe('signal_99');
  });

  it('triggeredAt = 0 is accepted and preserved', () => {
    const state = buildTriggerOutlineToDraftState(basePayload({ triggeredAt: 0 }));
    expect(state.triggeredAt).toBe(0);
  });

  it('buildNoOpState does not throw', () => {
    expect(() => buildNoOpState()).not.toThrow();
  });

  it('buildTriggerOutlineToDraftState does not throw for minimal payload', () => {
    expect(() =>
      buildTriggerOutlineToDraftState({
        userMessage: '',
        confidence: 0,
        signals: [],
      }),
    ).not.toThrow();
  });

  it('Korean userMessage is preserved verbatim', () => {
    const msg = '각 섹션을 작성해줘 — 전체 초안 작성 부탁드립니다';
    const state = buildTriggerOutlineToDraftState(basePayload({ userMessage: msg }));
    expect(state.userMessage).toBe(msg);
  });

  it('signals with Korean strings are preserved', () => {
    const signals = ['exact_trigger_ko', 'section_scope_ko', 'draft_verb_ko'];
    const state = buildTriggerOutlineToDraftState(basePayload({ signals }));
    expect(Array.from(state.signals)).toEqual(signals);
  });

  it('both constructors can be called in rapid succession without interference', () => {
    const results: WorkflowState[] = [];
    for (let i = 0; i < 20; i++) {
      if (i % 2 === 0) {
        results.push(buildTriggerOutlineToDraftState(basePayload({ confidence: i / 20 })));
      } else {
        results.push(buildNoOpState());
      }
    }
    expect(results.length).toBe(20);
    expect(results.filter((s) => s.type === 'trigger_outline_to_draft').length).toBe(10);
    expect(results.filter((s) => s.type === 'noop').length).toBe(10);
    // All are frozen
    expect(results.every((s) => Object.isFrozen(s))).toBe(true);
  });
});
