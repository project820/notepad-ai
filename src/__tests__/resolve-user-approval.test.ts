/**
 * resolve-user-approval.test.ts
 *
 * Unit tests for resolveUserApproval(card, action) — Sub-AC 6d-ii.
 *
 * Specification requirements:
 *   ✓ Approve branch returns a TriggerOutlineToDraftState
 *   ✓ Cancel branch returns a NoOpState
 *   ✓ Function is pure: same inputs always yield structurally equal outputs
 *
 * Test groups:
 *   A. Approve branch — TriggerOutlineToDraftState shape and field types
 *   B. Cancel branch  — NoOpState shape and determinism
 *   C. Purity         — structural equality for same inputs across multiple calls
 *   D. Type narrowing — WorkflowState discriminated union narrows correctly
 *   E. Immutability   — returned states are frozen (Object.freeze guarantee)
 *   F. Edge cases     — boundary card shapes, Korean content, minimal cards
 */

import { describe, it, expect } from 'vitest';
import { resolveUserApproval } from '../renderer/resolve-user-approval';
import type { ConfirmationCard } from '../renderer/confirmation-card';
import type {
  WorkflowState,
  TriggerOutlineToDraftState,
  NoOpState,
} from '../renderer/workflow-state';

// ---------------------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------------------

/**
 * Builds a minimal valid ConfirmationCard for English Outline→Draft intent.
 * Override individual fields via `overrides`.
 */
function makeCard(overrides: Partial<ConfirmationCard> = {}): ConfirmationCard {
  return {
    title: 'Start Outline→Draft?',
    description: 'AI will write body content for each section. You can review and accept or reject each section before it is inserted.',
    actions: [
      { id: 'start', label: 'Start', variant: 'primary' },
      { id: 'cancel', label: 'Cancel', variant: 'secondary' },
    ],
    ...overrides,
  };
}

/**
 * Builds a minimal valid ConfirmationCard for Korean Outline→Draft intent.
 */
function makeKoreanCard(): ConfirmationCard {
  return {
    title: '아웃라인 작성 시작할까요?',
    description: 'AI가 각 섹션의 본문을 자동으로 작성합니다. 각 섹션을 검토하고 수락 또는 거절할 수 있습니다.',
    actions: [
      { id: 'start', label: '시작', variant: 'primary' },
      { id: 'cancel', label: '취소', variant: 'secondary' },
    ],
  };
}

// ---------------------------------------------------------------------------
// A. Approve branch — returns TriggerOutlineToDraftState
// ---------------------------------------------------------------------------

describe('resolveUserApproval — approve branch', () => {
  it('returns an object with type === "trigger_outline_to_draft"', () => {
    const state = resolveUserApproval(makeCard(), 'approve');
    expect(state.type).toBe('trigger_outline_to_draft');
  });

  it('type field is not "noop"', () => {
    const state = resolveUserApproval(makeCard(), 'approve');
    expect(state.type).not.toBe('noop');
  });

  it('type field is a string', () => {
    const state = resolveUserApproval(makeCard(), 'approve');
    expect(typeof state.type).toBe('string');
  });

  it('approve result is narrowable to TriggerOutlineToDraftState', () => {
    const state = resolveUserApproval(makeCard(), 'approve');
    if (state.type !== 'trigger_outline_to_draft') {
      throw new Error('Expected trigger_outline_to_draft');
    }
    // TypeScript narrows here — all TriggerOutlineToDraftState fields are accessible
    expect(typeof state.userMessage).toBe('string');
    expect(typeof state.confidence).toBe('number');
    expect(typeof state.triggeredAt).toBe('number');
    expect(
      Array.isArray(state.signals) ||
      typeof (state.signals as unknown as { length: number }).length === 'number',
    ).toBe(true);
  });

  it('userMessage is a string', () => {
    const state = resolveUserApproval(makeCard(), 'approve');
    if (state.type === 'trigger_outline_to_draft') {
      expect(typeof state.userMessage).toBe('string');
    }
  });

  it('userMessage is derived from the card (deterministic for same card)', () => {
    const card = makeCard({ title: 'Start Outline→Draft?' });
    const a = resolveUserApproval(card, 'approve');
    const b = resolveUserApproval(card, 'approve');
    if (a.type === 'trigger_outline_to_draft' && b.type === 'trigger_outline_to_draft') {
      expect(a.userMessage).toBe(b.userMessage);
    }
  });

  it('userMessage reflects card.title (deterministic field)', () => {
    const card = makeCard({ title: 'Custom Card Title for Testing' });
    const state = resolveUserApproval(card, 'approve');
    if (state.type === 'trigger_outline_to_draft') {
      // userMessage must equal card.title — same card yields same userMessage
      expect(state.userMessage).toBe(card.title);
    }
  });

  it('confidence is a number', () => {
    const state = resolveUserApproval(makeCard(), 'approve');
    if (state.type === 'trigger_outline_to_draft') {
      expect(typeof state.confidence).toBe('number');
    }
  });

  it('confidence is in the valid range [0, 1]', () => {
    const state = resolveUserApproval(makeCard(), 'approve');
    if (state.type === 'trigger_outline_to_draft') {
      expect(state.confidence).toBeGreaterThanOrEqual(0);
      expect(state.confidence).toBeLessThanOrEqual(1);
    }
  });

  it('confidence is 1.0 — explicit user approval yields maximum confidence', () => {
    const state = resolveUserApproval(makeCard(), 'approve');
    if (state.type === 'trigger_outline_to_draft') {
      expect(state.confidence).toBe(1.0);
    }
  });

  it('signals is an array-like object with a length property', () => {
    const state = resolveUserApproval(makeCard(), 'approve');
    if (state.type === 'trigger_outline_to_draft') {
      expect(
        Array.isArray(state.signals) ||
        typeof (state.signals as unknown as { length: number }).length === 'number',
      ).toBe(true);
    }
  });

  it('signals is non-empty — at least one signal is present for user approval', () => {
    const state = resolveUserApproval(makeCard(), 'approve');
    if (state.type === 'trigger_outline_to_draft') {
      expect(state.signals.length).toBeGreaterThan(0);
    }
  });

  it('signals contains a string identifying the approval action', () => {
    const state = resolveUserApproval(makeCard(), 'approve');
    if (state.type === 'trigger_outline_to_draft') {
      for (const signal of state.signals) {
        expect(typeof signal).toBe('string');
        expect(signal.length).toBeGreaterThan(0);
      }
    }
  });

  it('triggeredAt is a number (Unix ms timestamp)', () => {
    const state = resolveUserApproval(makeCard(), 'approve');
    if (state.type === 'trigger_outline_to_draft') {
      expect(typeof state.triggeredAt).toBe('number');
    }
  });

  it('triggeredAt is a reasonable Unix ms timestamp (not NaN, not negative)', () => {
    const before = Date.now();
    const state = resolveUserApproval(makeCard(), 'approve');
    const after = Date.now();
    if (state.type === 'trigger_outline_to_draft') {
      expect(Number.isNaN(state.triggeredAt)).toBe(false);
      expect(state.triggeredAt).toBeGreaterThanOrEqual(before);
      expect(state.triggeredAt).toBeLessThanOrEqual(after);
    }
  });

  it('approve result is assignable to WorkflowState', () => {
    const state: WorkflowState = resolveUserApproval(makeCard(), 'approve');
    expect(state.type).toBe('trigger_outline_to_draft');
  });

  it('approve result is assignable to TriggerOutlineToDraftState when narrowed', () => {
    const state = resolveUserApproval(makeCard(), 'approve');
    if (state.type === 'trigger_outline_to_draft') {
      const typed: TriggerOutlineToDraftState = state;
      expect(typed.type).toBe('trigger_outline_to_draft');
    }
  });

  it('approve result has all expected keys (type, userMessage, confidence, signals, triggeredAt)', () => {
    const state = resolveUserApproval(makeCard(), 'approve');
    const keys = Object.keys(state).sort();
    expect(keys).toEqual(
      ['type', 'userMessage', 'confidence', 'signals', 'triggeredAt'].sort(),
    );
  });

  it('different card titles yield different userMessage values (input sensitivity)', () => {
    const card1 = makeCard({ title: 'Start Outline→Draft?' });
    const card2 = makeCard({ title: 'A Different Title' });
    const state1 = resolveUserApproval(card1, 'approve');
    const state2 = resolveUserApproval(card2, 'approve');
    if (
      state1.type === 'trigger_outline_to_draft' &&
      state2.type === 'trigger_outline_to_draft'
    ) {
      expect(state1.userMessage).not.toBe(state2.userMessage);
    }
  });
});

// ---------------------------------------------------------------------------
// B. Cancel branch — returns NoOpState
// ---------------------------------------------------------------------------

describe('resolveUserApproval — cancel branch', () => {
  it('returns an object with type === "noop"', () => {
    const state = resolveUserApproval(makeCard(), 'cancel');
    expect(state.type).toBe('noop');
  });

  it('type field is not "trigger_outline_to_draft"', () => {
    const state = resolveUserApproval(makeCard(), 'cancel');
    expect(state.type).not.toBe('trigger_outline_to_draft');
  });

  it('type field is a string', () => {
    const state = resolveUserApproval(makeCard(), 'cancel');
    expect(typeof state.type).toBe('string');
  });

  it('cancel result is narrowable to NoOpState', () => {
    const state = resolveUserApproval(makeCard(), 'cancel');
    if (state.type !== 'noop') {
      throw new Error('Expected noop');
    }
    // TypeScript narrows here — only state.type is accessible on NoOpState
    expect(state.type).toBe('noop');
  });

  it('cancel result does not have a userMessage field', () => {
    const state = resolveUserApproval(makeCard(), 'cancel') as Record<string, unknown>;
    expect('userMessage' in state).toBe(false);
  });

  it('cancel result does not have a confidence field', () => {
    const state = resolveUserApproval(makeCard(), 'cancel') as Record<string, unknown>;
    expect('confidence' in state).toBe(false);
  });

  it('cancel result does not have a signals field', () => {
    const state = resolveUserApproval(makeCard(), 'cancel') as Record<string, unknown>;
    expect('signals' in state).toBe(false);
  });

  it('cancel result does not have a triggeredAt field', () => {
    const state = resolveUserApproval(makeCard(), 'cancel') as Record<string, unknown>;
    expect('triggeredAt' in state).toBe(false);
  });

  it('cancel result has exactly one key: "type"', () => {
    const state = resolveUserApproval(makeCard(), 'cancel');
    const keys = Object.keys(state);
    expect(keys).toEqual(['type']);
  });

  it('cancel result is assignable to WorkflowState', () => {
    const state: WorkflowState = resolveUserApproval(makeCard(), 'cancel');
    expect(state.type).toBe('noop');
  });

  it('cancel result is assignable to NoOpState when narrowed', () => {
    const state = resolveUserApproval(makeCard(), 'cancel');
    if (state.type === 'noop') {
      const typed: NoOpState = state;
      expect(typed.type).toBe('noop');
    }
  });

  it('cancel result deeply equals { type: "noop" }', () => {
    const state = resolveUserApproval(makeCard(), 'cancel');
    expect(state).toEqual({ type: 'noop' });
  });

  it('cancel result is the same regardless of card title', () => {
    const cards = [
      makeCard({ title: 'A' }),
      makeCard({ title: 'Z' }),
      makeCard({ title: '아웃라인 작성 시작할까요?' }),
    ];
    for (const card of cards) {
      const state = resolveUserApproval(card, 'cancel');
      expect(state).toEqual({ type: 'noop' });
    }
  });

  it('cancel result is the same regardless of card description', () => {
    const cards = [
      makeCard({ description: '' }),
      makeCard({ description: 'Short.' }),
      makeCard({ description: 'AI will write body content for your 5 sections. You can review and accept or reject each section before it is inserted.' }),
    ];
    for (const card of cards) {
      const state = resolveUserApproval(card, 'cancel');
      expect(state).toEqual({ type: 'noop' });
    }
  });

  it('cancel result is the same regardless of card actions', () => {
    const cards = [
      makeCard({ actions: [{ id: 'start', label: 'Start' }] }),
      makeCard({ actions: [{ id: 'start', label: '시작', variant: 'primary' }, { id: 'cancel', label: '취소', variant: 'secondary' }] }),
      makeCard({ actions: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }] }),
    ];
    for (const card of cards) {
      const state = resolveUserApproval(card, 'cancel');
      expect(state).toEqual({ type: 'noop' });
    }
  });
});

// ---------------------------------------------------------------------------
// C. Purity — same inputs always yield structurally equal outputs
// ---------------------------------------------------------------------------

describe('resolveUserApproval — purity', () => {
  // Cancel branch is fully deterministic.
  it('cancel: two calls with the same card are deeply equal', () => {
    const card = makeCard();
    const a = resolveUserApproval(card, 'cancel');
    const b = resolveUserApproval(card, 'cancel');
    expect(a).toEqual(b);
  });

  it('cancel: five calls with the same card all equal { type: "noop" }', () => {
    const card = makeCard();
    const results = Array.from({ length: 5 }, () => resolveUserApproval(card, 'cancel'));
    for (const result of results) {
      expect(result).toEqual({ type: 'noop' });
    }
  });

  it('cancel: two calls with equal (but distinct) card objects are deeply equal', () => {
    const card1 = makeCard();
    const card2 = makeCard(); // structurally equal but different reference
    const a = resolveUserApproval(card1, 'cancel');
    const b = resolveUserApproval(card2, 'cancel');
    expect(a).toEqual(b);
  });

  // Approve branch: type, userMessage, confidence, and signals are deterministic.
  it('approve: type is "trigger_outline_to_draft" for every call with the same card', () => {
    const card = makeCard();
    const results = Array.from({ length: 5 }, () => resolveUserApproval(card, 'approve'));
    for (const result of results) {
      expect(result.type).toBe('trigger_outline_to_draft');
    }
  });

  it('approve: userMessage is equal across two calls with the same card', () => {
    const card = makeCard({ title: 'Deterministic Title' });
    const a = resolveUserApproval(card, 'approve');
    const b = resolveUserApproval(card, 'approve');
    if (a.type === 'trigger_outline_to_draft' && b.type === 'trigger_outline_to_draft') {
      expect(a.userMessage).toBe(b.userMessage);
    }
  });

  it('approve: userMessage is equal across five calls with the same card', () => {
    const card = makeCard({ title: 'Repeated Test Title' });
    const results = Array.from({ length: 5 }, () => resolveUserApproval(card, 'approve'));
    const approveResults = results.filter(
      (s): s is TriggerOutlineToDraftState => s.type === 'trigger_outline_to_draft',
    );
    expect(approveResults).toHaveLength(5);
    const userMessages = new Set(approveResults.map((s) => s.userMessage));
    expect(userMessages.size).toBe(1); // all calls produced the same userMessage
  });

  it('approve: confidence is equal across two calls with the same card', () => {
    const card = makeCard();
    const a = resolveUserApproval(card, 'approve');
    const b = resolveUserApproval(card, 'approve');
    if (a.type === 'trigger_outline_to_draft' && b.type === 'trigger_outline_to_draft') {
      expect(a.confidence).toBe(b.confidence);
    }
  });

  it('approve: confidence is equal across five calls with the same card', () => {
    const card = makeCard();
    const results = Array.from({ length: 5 }, () => resolveUserApproval(card, 'approve'));
    const approveResults = results.filter(
      (s): s is TriggerOutlineToDraftState => s.type === 'trigger_outline_to_draft',
    );
    const confidences = new Set(approveResults.map((s) => s.confidence));
    expect(confidences.size).toBe(1); // all calls produced the same confidence
  });

  it('approve: signals are structurally equal across two calls with the same card', () => {
    const card = makeCard();
    const a = resolveUserApproval(card, 'approve');
    const b = resolveUserApproval(card, 'approve');
    if (a.type === 'trigger_outline_to_draft' && b.type === 'trigger_outline_to_draft') {
      expect(Array.from(a.signals)).toEqual(Array.from(b.signals));
    }
  });

  it('approve: signals are structurally equal across five calls with the same card', () => {
    const card = makeCard();
    const results = Array.from({ length: 5 }, () => resolveUserApproval(card, 'approve'));
    const approveResults = results.filter(
      (s): s is TriggerOutlineToDraftState => s.type === 'trigger_outline_to_draft',
    );
    expect(approveResults).toHaveLength(5);
    const signalSets = approveResults.map((s) => JSON.stringify(Array.from(s.signals)));
    const unique = new Set(signalSets);
    expect(unique.size).toBe(1); // all calls produced the same signals
  });

  it('cancel then approve: cancel does not corrupt subsequent approve result', () => {
    const card = makeCard();
    resolveUserApproval(card, 'cancel'); // discard result
    const approveState = resolveUserApproval(card, 'approve');
    expect(approveState.type).toBe('trigger_outline_to_draft');
    if (approveState.type === 'trigger_outline_to_draft') {
      expect(approveState.confidence).toBe(1.0);
      expect(approveState.signals.length).toBeGreaterThan(0);
    }
  });

  it('approve then cancel: approve does not corrupt subsequent cancel result', () => {
    const card = makeCard();
    resolveUserApproval(card, 'approve'); // discard result
    const cancelState = resolveUserApproval(card, 'cancel');
    expect(cancelState.type).toBe('noop');
    expect(cancelState).toEqual({ type: 'noop' });
  });

  it('interleaved approve/cancel calls produce independent, correct results', () => {
    const card = makeCard();
    const s1 = resolveUserApproval(card, 'cancel');
    const s2 = resolveUserApproval(card, 'approve');
    const s3 = resolveUserApproval(card, 'cancel');
    const s4 = resolveUserApproval(card, 'approve');

    expect(s1.type).toBe('noop');
    expect(s2.type).toBe('trigger_outline_to_draft');
    expect(s3.type).toBe('noop');
    expect(s4.type).toBe('trigger_outline_to_draft');

    expect(s1).toEqual(s3); // both cancel results are deeply equal
    if (s2.type === 'trigger_outline_to_draft' && s4.type === 'trigger_outline_to_draft') {
      expect(s2.userMessage).toBe(s4.userMessage);
      expect(s2.confidence).toBe(s4.confidence);
      expect(Array.from(s2.signals)).toEqual(Array.from(s4.signals));
    }
  });

  it('approve: ten rapid successive calls all produce the same type and deterministic fields', () => {
    const card = makeCard({ title: 'Rapid Call Test' });
    const results = Array.from({ length: 10 }, () =>
      resolveUserApproval(card, 'approve'),
    );

    // All types are the same
    const types = new Set(results.map((s) => s.type));
    expect(types.size).toBe(1);
    expect([...types][0]).toBe('trigger_outline_to_draft');

    const approveResults = results.filter(
      (s): s is TriggerOutlineToDraftState => s.type === 'trigger_outline_to_draft',
    );

    // userMessage is stable
    const userMessages = new Set(approveResults.map((s) => s.userMessage));
    expect(userMessages.size).toBe(1);

    // confidence is stable
    const confidences = new Set(approveResults.map((s) => s.confidence));
    expect(confidences.size).toBe(1);

    // signals serialisation is stable
    const signalSets = new Set(
      approveResults.map((s) => JSON.stringify(Array.from(s.signals))),
    );
    expect(signalSets.size).toBe(1);
  });

  it('two structurally equal cards produce the same approve result (userMessage, confidence, signals)', () => {
    const card1 = makeCard({ title: 'Equal Cards Test' });
    const card2 = makeCard({ title: 'Equal Cards Test' }); // structurally equal
    const a = resolveUserApproval(card1, 'approve');
    const b = resolveUserApproval(card2, 'approve');
    if (a.type === 'trigger_outline_to_draft' && b.type === 'trigger_outline_to_draft') {
      expect(a.userMessage).toBe(b.userMessage);
      expect(a.confidence).toBe(b.confidence);
      expect(Array.from(a.signals)).toEqual(Array.from(b.signals));
    }
  });
});

// ---------------------------------------------------------------------------
// D. Type narrowing — WorkflowState discriminated union
// ---------------------------------------------------------------------------

describe('resolveUserApproval — type narrowing', () => {
  it('switch statement can exhaust all returned types without a default branch', () => {
    function describeState(state: WorkflowState): string {
      switch (state.type) {
        case 'trigger_outline_to_draft':
          return `draft:${state.userMessage}`;
        case 'noop':
          return 'noop';
      }
    }

    const approveState = resolveUserApproval(makeCard(), 'approve');
    const cancelState = resolveUserApproval(makeCard(), 'cancel');

    expect(describeState(approveState)).toMatch(/^draft:/);
    expect(describeState(cancelState)).toBe('noop');
  });

  it('approve: type guard gives access to TriggerOutlineToDraftState payload fields', () => {
    const state: WorkflowState = resolveUserApproval(makeCard(), 'approve');
    if (state.type === 'trigger_outline_to_draft') {
      // All TriggerOutlineToDraftState fields are accessible after narrowing
      expect(state.userMessage).toBeDefined();
      expect(typeof state.confidence).toBe('number');
      expect(typeof state.triggeredAt).toBe('number');
      expect(state.signals).toBeDefined();
    } else {
      throw new Error('Expected trigger_outline_to_draft');
    }
  });

  it('cancel: type guard limits access to just the type field (NoOpState)', () => {
    const state: WorkflowState = resolveUserApproval(makeCard(), 'cancel');
    if (state.type === 'noop') {
      // After narrowing to NoOpState: only `type` is a declared field
      expect(Object.keys(state)).toEqual(['type']);
    } else {
      throw new Error('Expected noop');
    }
  });

  it('approve result is narrowed by type === "trigger_outline_to_draft"', () => {
    const state = resolveUserApproval(makeCard(), 'approve');
    const isApprove = state.type === 'trigger_outline_to_draft';
    expect(isApprove).toBe(true);
  });

  it('cancel result is narrowed by type === "noop"', () => {
    const state = resolveUserApproval(makeCard(), 'cancel');
    const isNoop = state.type === 'noop';
    expect(isNoop).toBe(true);
  });

  it('WorkflowState array can hold both approve and cancel results', () => {
    const states: WorkflowState[] = [
      resolveUserApproval(makeCard(), 'approve'),
      resolveUserApproval(makeCard(), 'cancel'),
    ];
    expect(states[0].type).toBe('trigger_outline_to_draft');
    expect(states[1].type).toBe('noop');
  });
});

// ---------------------------------------------------------------------------
// E. Immutability — returned states are frozen (Object.freeze guarantee)
// ---------------------------------------------------------------------------

describe('resolveUserApproval — immutability', () => {
  it('approve branch returns a frozen object', () => {
    const state = resolveUserApproval(makeCard(), 'approve');
    expect(Object.isFrozen(state)).toBe(true);
  });

  it('cancel branch returns a frozen object', () => {
    const state = resolveUserApproval(makeCard(), 'cancel');
    expect(Object.isFrozen(state)).toBe(true);
  });

  it('approve: assigning to state.type throws TypeError (frozen strict mode)', () => {
    const state = resolveUserApproval(makeCard(), 'approve');
    expect(() => {
      // @ts-expect-error: intentionally mutating a readonly frozen field
      state.type = 'noop';
    }).toThrow(TypeError);
  });

  it('cancel: assigning to state.type throws TypeError (frozen strict mode)', () => {
    const state = resolveUserApproval(makeCard(), 'cancel');
    expect(() => {
      // @ts-expect-error: intentionally mutating a readonly frozen field
      state.type = 'trigger_outline_to_draft';
    }).toThrow(TypeError);
  });

  it('approve: assigning to state.confidence throws TypeError', () => {
    const state = resolveUserApproval(makeCard(), 'approve');
    expect(() => {
      // @ts-expect-error: intentionally mutating a readonly frozen field
      state.confidence = 0;
    }).toThrow(TypeError);
  });

  it('approve: assigning to state.userMessage throws TypeError', () => {
    const state = resolveUserApproval(makeCard(), 'approve');
    expect(() => {
      // @ts-expect-error: intentionally mutating a readonly frozen field
      state.userMessage = 'hacked';
    }).toThrow(TypeError);
  });

  it('approve: adding a new property throws TypeError', () => {
    const state = resolveUserApproval(makeCard(), 'approve');
    expect(() => {
      (state as Record<string, unknown>)['extra'] = 'injected';
    }).toThrow(TypeError);
  });

  it('cancel: adding a new property throws TypeError', () => {
    const state = resolveUserApproval(makeCard(), 'cancel');
    expect(() => {
      (state as Record<string, unknown>)['extra'] = 'injected';
    }).toThrow(TypeError);
  });

  it('approve: signals array is frozen (pushing throws TypeError)', () => {
    const state = resolveUserApproval(makeCard(), 'approve');
    if (state.type === 'trigger_outline_to_draft') {
      expect(Object.isFrozen(state.signals)).toBe(true);
      expect(() => {
        (state.signals as string[]).push('new_signal');
      }).toThrow(TypeError);
    }
  });

  it('each call returns a distinct object (not the same reference)', () => {
    const card = makeCard();
    const a = resolveUserApproval(card, 'approve');
    const b = resolveUserApproval(card, 'approve');
    expect(a).not.toBe(b);
    expect(Object.isFrozen(a)).toBe(true);
    expect(Object.isFrozen(b)).toBe(true);
  });

  it('cancel: each call returns a distinct frozen object', () => {
    const card = makeCard();
    const a = resolveUserApproval(card, 'cancel');
    const b = resolveUserApproval(card, 'cancel');
    expect(a).not.toBe(b);
    expect(Object.isFrozen(a)).toBe(true);
    expect(Object.isFrozen(b)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// F. Edge cases — boundary card shapes, Korean content, minimal cards
// ---------------------------------------------------------------------------

describe('resolveUserApproval — edge cases', () => {
  it('handles a card with the minimum single action (approve)', () => {
    const card = makeCard({
      actions: [{ id: 'start', label: 'Start', variant: 'primary' }],
    });
    const state = resolveUserApproval(card, 'approve');
    expect(state.type).toBe('trigger_outline_to_draft');
  });

  it('handles a card with the minimum single action (cancel)', () => {
    const card = makeCard({
      actions: [{ id: 'start', label: 'Start', variant: 'primary' }],
    });
    const state = resolveUserApproval(card, 'cancel');
    expect(state.type).toBe('noop');
  });

  it('handles a card with empty description (approve)', () => {
    const card = makeCard({ description: '' });
    const state = resolveUserApproval(card, 'approve');
    expect(state.type).toBe('trigger_outline_to_draft');
  });

  it('handles a card with empty description (cancel)', () => {
    const card = makeCard({ description: '' });
    const state = resolveUserApproval(card, 'cancel');
    expect(state.type).toBe('noop');
  });

  it('handles Korean card title for approve — returns TriggerOutlineToDraftState', () => {
    const card = makeKoreanCard();
    const state = resolveUserApproval(card, 'approve');
    expect(state.type).toBe('trigger_outline_to_draft');
    if (state.type === 'trigger_outline_to_draft') {
      expect(state.userMessage).toBe('아웃라인 작성 시작할까요?');
    }
  });

  it('handles Korean card title for cancel — returns NoOpState', () => {
    const card = makeKoreanCard();
    const state = resolveUserApproval(card, 'cancel');
    expect(state.type).toBe('noop');
    expect(state).toEqual({ type: 'noop' });
  });

  it('Korean approve: purity holds across two calls', () => {
    const card = makeKoreanCard();
    const a = resolveUserApproval(card, 'approve');
    const b = resolveUserApproval(card, 'approve');
    if (a.type === 'trigger_outline_to_draft' && b.type === 'trigger_outline_to_draft') {
      expect(a.userMessage).toBe(b.userMessage);
      expect(a.confidence).toBe(b.confidence);
      expect(Array.from(a.signals)).toEqual(Array.from(b.signals));
    }
  });

  it('does not throw for approve action', () => {
    expect(() => resolveUserApproval(makeCard(), 'approve')).not.toThrow();
  });

  it('does not throw for cancel action', () => {
    expect(() => resolveUserApproval(makeCard(), 'cancel')).not.toThrow();
  });

  it('does not throw for Korean card + approve', () => {
    expect(() => resolveUserApproval(makeKoreanCard(), 'approve')).not.toThrow();
  });

  it('does not throw for Korean card + cancel', () => {
    expect(() => resolveUserApproval(makeKoreanCard(), 'cancel')).not.toThrow();
  });

  it('card with three actions — approve still returns TriggerOutlineToDraftState', () => {
    const card = makeCard({
      actions: [
        { id: 'start', label: 'Start', variant: 'primary' },
        { id: 'edit', label: 'Edit Outline', variant: 'secondary' },
        { id: 'cancel', label: 'Cancel', variant: 'secondary' },
      ],
    });
    const state = resolveUserApproval(card, 'approve');
    expect(state.type).toBe('trigger_outline_to_draft');
  });

  it('card with three actions — cancel still returns NoOpState', () => {
    const card = makeCard({
      actions: [
        { id: 'start', label: 'Start', variant: 'primary' },
        { id: 'edit', label: 'Edit Outline', variant: 'secondary' },
        { id: 'cancel', label: 'Cancel', variant: 'secondary' },
      ],
    });
    const state = resolveUserApproval(card, 'cancel');
    expect(state.type).toBe('noop');
  });

  it('very long card title is propagated correctly to approve state userMessage', () => {
    const longTitle = 'Start Outline→Draft? '.repeat(100).trim();
    const card = makeCard({ title: longTitle });
    const state = resolveUserApproval(card, 'approve');
    if (state.type === 'trigger_outline_to_draft') {
      expect(state.userMessage).toBe(longTitle);
    }
  });

  it('approve after cancel returns fresh TriggerOutlineToDraftState each time', () => {
    const card = makeCard();
    const cancel1 = resolveUserApproval(card, 'cancel');
    const approve1 = resolveUserApproval(card, 'approve');
    const cancel2 = resolveUserApproval(card, 'cancel');
    const approve2 = resolveUserApproval(card, 'approve');

    expect(cancel1.type).toBe('noop');
    expect(cancel2.type).toBe('noop');
    expect(approve1.type).toBe('trigger_outline_to_draft');
    expect(approve2.type).toBe('trigger_outline_to_draft');

    // approve results are distinct objects but structurally equal (except triggeredAt)
    expect(approve1).not.toBe(approve2);
    if (
      approve1.type === 'trigger_outline_to_draft' &&
      approve2.type === 'trigger_outline_to_draft'
    ) {
      expect(approve1.userMessage).toBe(approve2.userMessage);
      expect(approve1.confidence).toBe(approve2.confidence);
      expect(Array.from(approve1.signals)).toEqual(Array.from(approve2.signals));
    }
  });
});
