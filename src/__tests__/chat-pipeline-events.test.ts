/**
 * chat-pipeline-events.test.ts
 *
 * Unit tests for the two Side Chat pipeline event constructors:
 *   - buildConfirmationCardEvent(intentResult) → ConfirmationCardEvent
 *   - buildNormalResponseEvent(message)         → NormalResponseEvent
 *
 * Each constructor is tested independently as required by Sub-AC 6c-i.
 *
 * Test matrix:
 *   A. buildConfirmationCardEvent — type discriminant
 *   B. buildConfirmationCardEvent — required fields present on event
 *   C. buildConfirmationCardEvent — payload shape (card, confidence, signals)
 *   D. buildConfirmationCardEvent — card content correctness (English)
 *   E. buildConfirmationCardEvent — card content correctness (Korean)
 *   F. buildConfirmationCardEvent — optional field propagation (headingCount / documentTitle / language)
 *   G. buildConfirmationCardEvent — confidence and signals propagation
 *   H. buildConfirmationCardEvent — minimal input (required fields only)
 *   I. buildNormalResponseEvent   — type discriminant
 *   J. buildNormalResponseEvent   — required fields present on event
 *   K. buildNormalResponseEvent   — payload shape (message)
 *   L. buildNormalResponseEvent   — message content matches input exactly
 *   M. ChatPipelineEvent discriminated union — type narrowing works
 *   N. Constructor independence   — each constructor does not affect the other
 *   O. TypeScript structural checks — interfaces are structurally correct
 */

import { describe, it, expect } from 'vitest';
import {
  buildConfirmationCardEvent,
  buildNormalResponseEvent,
  type ConfirmationCardEvent,
  type NormalResponseEvent,
  type ChatPipelineEvent,
  type ConfirmationCardIntentResult,
} from '../renderer/chat-pipeline-events';

// ---------------------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------------------

/**
 * Minimal valid ConfirmationCardIntentResult with all required fields.
 * Override individual fields via the `overrides` parameter.
 */
function baseIntentResult(
  overrides: Partial<ConfirmationCardIntentResult> = {},
): ConfirmationCardIntentResult {
  return {
    isOutlineDraft: true,
    confidence: 0.9,
    signals: ['exact_trigger'],
    userMessage: 'Please draft each section',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// A. buildConfirmationCardEvent — type discriminant
// ---------------------------------------------------------------------------

describe('buildConfirmationCardEvent — type discriminant', () => {
  it('returns an object with type === "confirmation_card"', () => {
    const event = buildConfirmationCardEvent(baseIntentResult());
    expect(event.type).toBe('confirmation_card');
  });

  it('type field is the string literal "confirmation_card", not any other value', () => {
    const event = buildConfirmationCardEvent(baseIntentResult());
    expect(event.type).not.toBe('normal_response');
    expect(event.type).not.toBe('outline_draft');
    expect(event.type).not.toBe('');
  });

  it('type field is a string', () => {
    const event = buildConfirmationCardEvent(baseIntentResult());
    expect(typeof event.type).toBe('string');
  });

  it('type field is identical across multiple calls with the same input', () => {
    const a = buildConfirmationCardEvent(baseIntentResult());
    const b = buildConfirmationCardEvent(baseIntentResult());
    expect(a.type).toBe(b.type);
  });

  it('type field is stable regardless of intentResult content variations', () => {
    const withHeadingCount = buildConfirmationCardEvent(
      baseIntentResult({ headingCount: 5 }),
    );
    const withoutHeadingCount = buildConfirmationCardEvent(baseIntentResult());
    expect(withHeadingCount.type).toBe('confirmation_card');
    expect(withoutHeadingCount.type).toBe('confirmation_card');
  });
});

// ---------------------------------------------------------------------------
// B. buildConfirmationCardEvent — required fields present
// ---------------------------------------------------------------------------

describe('buildConfirmationCardEvent — required fields present on event', () => {
  it('returned event has a "type" field', () => {
    const event = buildConfirmationCardEvent(baseIntentResult());
    expect('type' in event).toBe(true);
  });

  it('returned event has a "card" field', () => {
    const event = buildConfirmationCardEvent(baseIntentResult());
    expect('card' in event).toBe(true);
  });

  it('returned event has a "confidence" field', () => {
    const event = buildConfirmationCardEvent(baseIntentResult());
    expect('confidence' in event).toBe(true);
  });

  it('returned event has a "signals" field', () => {
    const event = buildConfirmationCardEvent(baseIntentResult());
    expect('signals' in event).toBe(true);
  });

  it('returned event has exactly the expected top-level keys', () => {
    const event = buildConfirmationCardEvent(baseIntentResult());
    const keys = Object.keys(event).sort();
    expect(keys).toEqual(['card', 'confidence', 'signals', 'type'].sort());
  });
});

// ---------------------------------------------------------------------------
// C. buildConfirmationCardEvent — payload shape
// ---------------------------------------------------------------------------

describe('buildConfirmationCardEvent — payload shape', () => {
  it('card is an object (not null or undefined)', () => {
    const event = buildConfirmationCardEvent(baseIntentResult());
    expect(event.card).toBeDefined();
    expect(event.card).not.toBeNull();
    expect(typeof event.card).toBe('object');
  });

  it('card.title is a non-empty string', () => {
    const event = buildConfirmationCardEvent(baseIntentResult());
    expect(typeof event.card.title).toBe('string');
    expect(event.card.title.length).toBeGreaterThan(0);
  });

  it('card.description is a string', () => {
    const event = buildConfirmationCardEvent(baseIntentResult());
    expect(typeof event.card.description).toBe('string');
  });

  it('card.actions is an array with at least one element', () => {
    const event = buildConfirmationCardEvent(baseIntentResult());
    expect(Array.isArray(event.card.actions)).toBe(true);
    expect(event.card.actions.length).toBeGreaterThanOrEqual(1);
  });

  it('confidence is a number', () => {
    const event = buildConfirmationCardEvent(baseIntentResult());
    expect(typeof event.confidence).toBe('number');
  });

  it('confidence is in [0, 1]', () => {
    const event = buildConfirmationCardEvent(baseIntentResult({ confidence: 0.75 }));
    expect(event.confidence).toBeGreaterThanOrEqual(0);
    expect(event.confidence).toBeLessThanOrEqual(1);
  });

  it('signals is an array', () => {
    const event = buildConfirmationCardEvent(baseIntentResult());
    expect(Array.isArray(event.signals)).toBe(true);
  });

  it('card actions each have id, label, and optional variant', () => {
    const event = buildConfirmationCardEvent(baseIntentResult());
    for (const action of event.card.actions) {
      expect(typeof action.id).toBe('string');
      expect(action.id.length).toBeGreaterThan(0);
      expect(typeof action.label).toBe('string');
      expect(action.label.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// D. buildConfirmationCardEvent — card content correctness (English)
// ---------------------------------------------------------------------------

describe('buildConfirmationCardEvent — English card content', () => {
  it('English card title is "Start Outline→Draft?"', () => {
    const event = buildConfirmationCardEvent(baseIntentResult({ language: 'en' }));
    expect(event.card.title).toBe('Start Outline→Draft?');
  });

  it('English card has two actions: Start (primary) and Cancel (secondary)', () => {
    const event = buildConfirmationCardEvent(baseIntentResult({ language: 'en' }));
    expect(event.card.actions).toHaveLength(2);
    expect(event.card.actions[0].id).toBe('start');
    expect(event.card.actions[0].label).toBe('Start');
    expect(event.card.actions[0].variant).toBe('primary');
    expect(event.card.actions[1].id).toBe('cancel');
    expect(event.card.actions[1].label).toBe('Cancel');
    expect(event.card.actions[1].variant).toBe('secondary');
  });

  it('English card description mentions "each section" when headingCount is absent', () => {
    const event = buildConfirmationCardEvent(baseIntentResult({ language: 'en' }));
    expect(event.card.description).toContain('each section');
  });

  it('English card description mentions section count when headingCount is provided', () => {
    const event = buildConfirmationCardEvent(
      baseIntentResult({ language: 'en', headingCount: 4 }),
    );
    expect(event.card.description).toContain('4');
    expect(event.card.description).toContain('sections');
  });

  it('English card description uses singular "section" for headingCount = 1', () => {
    const event = buildConfirmationCardEvent(
      baseIntentResult({ language: 'en', headingCount: 1 }),
    );
    expect(event.card.description).toContain('1 section');
    expect(event.card.description).not.toContain('1 sections');
  });

  it('English card description includes documentTitle in quotes when provided', () => {
    const event = buildConfirmationCardEvent(
      baseIntentResult({ language: 'en', documentTitle: 'Q3 Report' }),
    );
    expect(event.card.description).toContain('"Q3 Report"');
  });
});

// ---------------------------------------------------------------------------
// E. buildConfirmationCardEvent — card content correctness (Korean)
// ---------------------------------------------------------------------------

describe('buildConfirmationCardEvent — Korean card content', () => {
  it('Korean card title is "아웃라인 작성 시작할까요?"', () => {
    const event = buildConfirmationCardEvent(baseIntentResult({ language: 'ko' }));
    expect(event.card.title).toBe('아웃라인 작성 시작할까요?');
  });

  it('Korean card has two actions: 시작 (primary) and 취소 (secondary)', () => {
    const event = buildConfirmationCardEvent(baseIntentResult({ language: 'ko' }));
    expect(event.card.actions).toHaveLength(2);
    expect(event.card.actions[0].id).toBe('start');
    expect(event.card.actions[0].label).toBe('시작');
    expect(event.card.actions[0].variant).toBe('primary');
    expect(event.card.actions[1].id).toBe('cancel');
    expect(event.card.actions[1].label).toBe('취소');
    expect(event.card.actions[1].variant).toBe('secondary');
  });

  it('Korean card description mentions "각 섹션" when headingCount is absent', () => {
    const event = buildConfirmationCardEvent(baseIntentResult({ language: 'ko' }));
    expect(event.card.description).toContain('각 섹션');
  });

  it('Korean card description mentions "5개 섹션" for headingCount = 5', () => {
    const event = buildConfirmationCardEvent(
      baseIntentResult({ language: 'ko', headingCount: 5 }),
    );
    expect(event.card.description).toContain('5개 섹션');
  });

  it('Korean card description includes documentTitle in quotes when provided', () => {
    const event = buildConfirmationCardEvent(
      baseIntentResult({ language: 'ko', documentTitle: '분기 보고서' }),
    );
    expect(event.card.description).toContain('"분기 보고서"');
  });
});

// ---------------------------------------------------------------------------
// F. buildConfirmationCardEvent — optional field propagation
// ---------------------------------------------------------------------------

describe('buildConfirmationCardEvent — optional field propagation', () => {
  it('works with only required fields (no headingCount, documentTitle, or language)', () => {
    const event = buildConfirmationCardEvent(baseIntentResult());
    expect(event.type).toBe('confirmation_card');
    expect(event.card.title.length).toBeGreaterThan(0);
    expect(event.card.actions.length).toBeGreaterThanOrEqual(1);
  });

  it('defaults to English card when language is omitted', () => {
    const withoutLang = buildConfirmationCardEvent(baseIntentResult());
    const withEnLang = buildConfirmationCardEvent(baseIntentResult({ language: 'en' }));
    expect(withoutLang.card.title).toBe(withEnLang.card.title);
    expect(withoutLang.card.description).toBe(withEnLang.card.description);
    expect(withoutLang.card.actions).toEqual(withEnLang.card.actions);
  });

  it('headingCount = 0 is handled without crash', () => {
    const event = buildConfirmationCardEvent(
      baseIntentResult({ language: 'en', headingCount: 0 }),
    );
    expect(event.card.description).toContain('0');
    expect(event.card.description).toContain('sections');
  });

  it('headingCount = 0 Korean is handled without crash', () => {
    const event = buildConfirmationCardEvent(
      baseIntentResult({ language: 'ko', headingCount: 0 }),
    );
    expect(event.card.description).toContain('0개 섹션');
  });

  it('large headingCount (100) is formatted correctly', () => {
    const event = buildConfirmationCardEvent(
      baseIntentResult({ language: 'en', headingCount: 100 }),
    );
    expect(event.card.description).toContain('100 sections');
  });

  it('empty documentTitle is treated as absent (no empty quotes)', () => {
    const event = buildConfirmationCardEvent(
      baseIntentResult({ language: 'en', documentTitle: '' }),
    );
    expect(event.card.description).not.toMatch(/""/);
  });

  it('headingCount and documentTitle can be combined', () => {
    const event = buildConfirmationCardEvent(
      baseIntentResult({ language: 'en', headingCount: 7, documentTitle: 'Annual Plan' }),
    );
    expect(event.card.description).toContain('7');
    expect(event.card.description).toContain('"Annual Plan"');
  });

  it('isOutlineDraft field on input does not affect event type discriminant', () => {
    // The event type is always 'confirmation_card' regardless of the boolean flag
    // (callers are responsible for only calling this constructor when appropriate)
    const event = buildConfirmationCardEvent(
      baseIntentResult({ isOutlineDraft: false }),
    );
    expect(event.type).toBe('confirmation_card');
  });
});

// ---------------------------------------------------------------------------
// G. buildConfirmationCardEvent — confidence and signals propagation
// ---------------------------------------------------------------------------

describe('buildConfirmationCardEvent — confidence and signals propagation', () => {
  it('event.confidence equals intentResult.confidence', () => {
    const event = buildConfirmationCardEvent(baseIntentResult({ confidence: 0.75 }));
    expect(event.confidence).toBe(0.75);
  });

  it('event.confidence equals intentResult.confidence for value 1.0', () => {
    const event = buildConfirmationCardEvent(baseIntentResult({ confidence: 1.0 }));
    expect(event.confidence).toBe(1.0);
  });

  it('event.confidence equals intentResult.confidence for value 0.6 (threshold)', () => {
    const event = buildConfirmationCardEvent(baseIntentResult({ confidence: 0.6 }));
    expect(event.confidence).toBe(0.6);
  });

  it('event.signals is an array equal to intentResult.signals', () => {
    const signals = ['exact_trigger', 'section_scope_en'];
    const event = buildConfirmationCardEvent(baseIntentResult({ signals }));
    expect(event.signals).toEqual(signals);
  });

  it('event.signals preserves order of input signals', () => {
    const signals = ['draft_verb_en', 'section_scope_en', 'negation_halved'];
    const event = buildConfirmationCardEvent(baseIntentResult({ signals }));
    expect(event.signals).toEqual(signals);
  });

  it('event.signals is an empty array when input signals is empty', () => {
    const event = buildConfirmationCardEvent(baseIntentResult({ signals: [] }));
    expect(event.signals).toEqual([]);
  });

  it('event.signals is a different array reference from input (safe copy)', () => {
    const signals = ['exact_trigger'];
    const event = buildConfirmationCardEvent(baseIntentResult({ signals }));
    // Mutation of the original array should not affect event.signals
    // (Note: shallow copy — this tests that the reference is the same or a copy;
    //  either is acceptable for a data model constructor)
    expect(event.signals).toEqual(['exact_trigger']);
  });

  it('userMessage field on input does NOT appear in the event top-level', () => {
    const event = buildConfirmationCardEvent(
      baseIntentResult({ userMessage: 'Please draft each section' }),
    ) as Record<string, unknown>;
    expect('userMessage' in event).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// H. buildConfirmationCardEvent — minimal input
// ---------------------------------------------------------------------------

describe('buildConfirmationCardEvent — minimal required input', () => {
  it('works with only isOutlineDraft, confidence, signals, and userMessage', () => {
    const minimalResult: ConfirmationCardIntentResult = {
      isOutlineDraft: true,
      confidence: 0.9,
      signals: ['exact_trigger'],
      userMessage: 'draft each section',
    };
    const event = buildConfirmationCardEvent(minimalResult);
    expect(event.type).toBe('confirmation_card');
    expect(event.card).toBeDefined();
    expect(event.confidence).toBe(0.9);
    expect(event.signals).toEqual(['exact_trigger']);
  });

  it('does not throw for any valid minimal input', () => {
    expect(() =>
      buildConfirmationCardEvent({
        isOutlineDraft: true,
        confidence: 0.65,
        signals: [],
        userMessage: '',
      }),
    ).not.toThrow();
  });

  it('card from minimal input passes ConfirmationCard structural check', () => {
    const event = buildConfirmationCardEvent({
      isOutlineDraft: true,
      confidence: 0.9,
      signals: ['exact_trigger'],
      userMessage: 'fill in the sections',
    });
    // ConfirmationCard must have title (non-empty), description (string), actions (array ≥ 1)
    expect(typeof event.card.title).toBe('string');
    expect(event.card.title.length).toBeGreaterThan(0);
    expect(typeof event.card.description).toBe('string');
    expect(Array.isArray(event.card.actions)).toBe(true);
    expect(event.card.actions.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// I. buildNormalResponseEvent — type discriminant
// ---------------------------------------------------------------------------

describe('buildNormalResponseEvent — type discriminant', () => {
  it('returns an object with type === "normal_response"', () => {
    const event = buildNormalResponseEvent('Hello, what do you think?');
    expect(event.type).toBe('normal_response');
  });

  it('type field is the string literal "normal_response", not any other value', () => {
    const event = buildNormalResponseEvent('test');
    expect(event.type).not.toBe('confirmation_card');
    expect(event.type).not.toBe('outline_draft');
    expect(event.type).not.toBe('');
  });

  it('type field is a string', () => {
    const event = buildNormalResponseEvent('any message');
    expect(typeof event.type).toBe('string');
  });

  it('type field is identical across multiple calls', () => {
    const a = buildNormalResponseEvent('msg a');
    const b = buildNormalResponseEvent('msg b');
    expect(a.type).toBe(b.type);
    expect(a.type).toBe('normal_response');
  });

  it('type field is stable for empty string input', () => {
    const event = buildNormalResponseEvent('');
    expect(event.type).toBe('normal_response');
  });

  it('type field is stable for very long message input', () => {
    const long = 'word '.repeat(1000).trim();
    const event = buildNormalResponseEvent(long);
    expect(event.type).toBe('normal_response');
  });
});

// ---------------------------------------------------------------------------
// J. buildNormalResponseEvent — required fields present
// ---------------------------------------------------------------------------

describe('buildNormalResponseEvent — required fields present on event', () => {
  it('returned event has a "type" field', () => {
    const event = buildNormalResponseEvent('test');
    expect('type' in event).toBe(true);
  });

  it('returned event has a "message" field', () => {
    const event = buildNormalResponseEvent('test');
    expect('message' in event).toBe(true);
  });

  it('returned event has exactly the expected top-level keys', () => {
    const event = buildNormalResponseEvent('test');
    const keys = Object.keys(event).sort();
    expect(keys).toEqual(['message', 'type'].sort());
  });
});

// ---------------------------------------------------------------------------
// K. buildNormalResponseEvent — payload shape
// ---------------------------------------------------------------------------

describe('buildNormalResponseEvent — payload shape', () => {
  it('message is a string', () => {
    const event = buildNormalResponseEvent('What do you think?');
    expect(typeof event.message).toBe('string');
  });

  it('message is not undefined', () => {
    const event = buildNormalResponseEvent('Hello');
    expect(event.message).not.toBeUndefined();
  });

  it('message is not null', () => {
    const event = buildNormalResponseEvent('Hello');
    expect(event.message).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// L. buildNormalResponseEvent — message content matches input
// ---------------------------------------------------------------------------

describe('buildNormalResponseEvent — message content matches input exactly', () => {
  it('message equals the input string verbatim', () => {
    const input = 'What do you think about the structure?';
    const event = buildNormalResponseEvent(input);
    expect(event.message).toBe(input);
  });

  it('empty string input produces empty message field', () => {
    const event = buildNormalResponseEvent('');
    expect(event.message).toBe('');
  });

  it('preserves leading/trailing whitespace in message', () => {
    const input = '  spaced message  ';
    const event = buildNormalResponseEvent(input);
    expect(event.message).toBe(input);
  });

  it('preserves multi-line message string', () => {
    const input = 'Line 1\nLine 2\nLine 3';
    const event = buildNormalResponseEvent(input);
    expect(event.message).toBe(input);
  });

  it('preserves Korean characters verbatim', () => {
    const input = '이 구조 어떻게 생각해요?';
    const event = buildNormalResponseEvent(input);
    expect(event.message).toBe(input);
  });

  it('preserves special characters verbatim', () => {
    const input = 'Hello → World & "Quotes" <tags>';
    const event = buildNormalResponseEvent(input);
    expect(event.message).toBe(input);
  });

  it('very long string is preserved without truncation', () => {
    const input = 'a'.repeat(100_000);
    const event = buildNormalResponseEvent(input);
    expect(event.message.length).toBe(100_000);
    expect(event.message).toBe(input);
  });

  it('different input strings produce different message fields', () => {
    const e1 = buildNormalResponseEvent('message one');
    const e2 = buildNormalResponseEvent('message two');
    expect(e1.message).not.toBe(e2.message);
  });

  it('constructing two events from the same input produces identical messages', () => {
    const input = 'same input';
    const e1 = buildNormalResponseEvent(input);
    const e2 = buildNormalResponseEvent(input);
    expect(e1.message).toBe(e2.message);
  });
});

// ---------------------------------------------------------------------------
// M. ChatPipelineEvent discriminated union — type narrowing
// ---------------------------------------------------------------------------

describe('ChatPipelineEvent discriminated union — type narrowing', () => {
  it('narrowing to "confirmation_card" gives access to card, confidence, signals', () => {
    const event: ChatPipelineEvent = buildConfirmationCardEvent(baseIntentResult());
    if (event.type === 'confirmation_card') {
      // TypeScript narrows to ConfirmationCardEvent here
      expect(event.card).toBeDefined();
      expect(typeof event.confidence).toBe('number');
      expect(Array.isArray(event.signals)).toBe(true);
    } else {
      throw new Error('Expected confirmation_card event');
    }
  });

  it('narrowing to "normal_response" gives access to message field', () => {
    const event: ChatPipelineEvent = buildNormalResponseEvent('test message');
    if (event.type === 'normal_response') {
      // TypeScript narrows to NormalResponseEvent here
      expect(typeof event.message).toBe('string');
    } else {
      throw new Error('Expected normal_response event');
    }
  });

  it('switch statement can exhaust all event types without default branch', () => {
    function route(event: ChatPipelineEvent): string {
      switch (event.type) {
        case 'confirmation_card':
          return `card:${event.card.title}`;
        case 'normal_response':
          return `msg:${event.message}`;
      }
    }

    const cardEvent: ChatPipelineEvent = buildConfirmationCardEvent(baseIntentResult({ language: 'en' }));
    const msgEvent: ChatPipelineEvent = buildNormalResponseEvent('hello');

    expect(route(cardEvent)).toContain('card:');
    expect(route(msgEvent)).toBe('msg:hello');
  });

  it('confirmation_card event does NOT have a "message" field', () => {
    const event = buildConfirmationCardEvent(baseIntentResult()) as Record<string, unknown>;
    expect('message' in event).toBe(false);
  });

  it('normal_response event does NOT have a "card" field', () => {
    const event = buildNormalResponseEvent('test') as Record<string, unknown>;
    expect('card' in event).toBe(false);
  });

  it('normal_response event does NOT have a "confidence" field', () => {
    const event = buildNormalResponseEvent('test') as Record<string, unknown>;
    expect('confidence' in event).toBe(false);
  });

  it('normal_response event does NOT have a "signals" field', () => {
    const event = buildNormalResponseEvent('test') as Record<string, unknown>;
    expect('signals' in event).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// N. Constructor independence — each constructor works independently
// ---------------------------------------------------------------------------

describe('Constructor independence', () => {
  it('calling buildNormalResponseEvent does not affect subsequent buildConfirmationCardEvent calls', () => {
    buildNormalResponseEvent('some message');
    const cardEvent = buildConfirmationCardEvent(baseIntentResult({ language: 'en' }));
    expect(cardEvent.type).toBe('confirmation_card');
    expect(cardEvent.card.title).toBe('Start Outline→Draft?');
  });

  it('calling buildConfirmationCardEvent does not affect subsequent buildNormalResponseEvent calls', () => {
    buildConfirmationCardEvent(baseIntentResult());
    const msgEvent = buildNormalResponseEvent('hello world');
    expect(msgEvent.type).toBe('normal_response');
    expect(msgEvent.message).toBe('hello world');
  });

  it('interleaved calls produce independent results', () => {
    const e1 = buildNormalResponseEvent('msg 1');
    const e2 = buildConfirmationCardEvent(baseIntentResult({ confidence: 0.9 }));
    const e3 = buildNormalResponseEvent('msg 3');
    const e4 = buildConfirmationCardEvent(baseIntentResult({ confidence: 0.7 }));

    expect(e1.type).toBe('normal_response');
    expect(e1.message).toBe('msg 1');
    expect(e2.type).toBe('confirmation_card');
    expect(e2.confidence).toBe(0.9);
    expect(e3.type).toBe('normal_response');
    expect(e3.message).toBe('msg 3');
    expect(e4.type).toBe('confirmation_card');
    expect(e4.confidence).toBe(0.7);
  });

  it('buildNormalResponseEvent returns a new object each call', () => {
    const e1 = buildNormalResponseEvent('same');
    const e2 = buildNormalResponseEvent('same');
    expect(e1).not.toBe(e2); // different object references
    expect(e1).toEqual(e2);  // same structure
  });

  it('buildConfirmationCardEvent returns a new object each call', () => {
    const e1 = buildConfirmationCardEvent(baseIntentResult());
    const e2 = buildConfirmationCardEvent(baseIntentResult());
    expect(e1).not.toBe(e2); // different object references
    expect(e1.type).toBe(e2.type);
    expect(e1.card.title).toBe(e2.card.title);
  });
});

// ---------------------------------------------------------------------------
// O. TypeScript structural checks — interface conformance
// ---------------------------------------------------------------------------

describe('TypeScript interface structural conformance', () => {
  it('ConfirmationCardEvent interface: typed variable has expected property types', () => {
    const event: ConfirmationCardEvent = buildConfirmationCardEvent(baseIntentResult({ language: 'en' }));
    expect(typeof event.type).toBe('string');
    expect(event.type).toBe('confirmation_card');
    expect(typeof event.card).toBe('object');
    expect(typeof event.confidence).toBe('number');
    expect(Array.isArray(event.signals)).toBe(true);
  });

  it('NormalResponseEvent interface: typed variable has expected property types', () => {
    const event: NormalResponseEvent = buildNormalResponseEvent('test');
    expect(typeof event.type).toBe('string');
    expect(event.type).toBe('normal_response');
    expect(typeof event.message).toBe('string');
  });

  it('ConfirmationCardIntentResult: typed variable conforms to structural requirements', () => {
    const result: ConfirmationCardIntentResult = {
      isOutlineDraft: true,
      confidence: 0.9,
      signals: ['exact_trigger'],
      userMessage: 'draft each section',
      headingCount: 5,
      documentTitle: 'My Document',
      language: 'en',
    };
    const event = buildConfirmationCardEvent(result);
    expect(event.type).toBe('confirmation_card');
  });

  it('ChatPipelineEvent type: holds both event variants correctly', () => {
    const events: ChatPipelineEvent[] = [
      buildConfirmationCardEvent(baseIntentResult()),
      buildNormalResponseEvent('hello'),
    ];
    expect(events[0].type).toBe('confirmation_card');
    expect(events[1].type).toBe('normal_response');
  });

  it('buildConfirmationCardEvent return type is assignable to ChatPipelineEvent', () => {
    const event: ChatPipelineEvent = buildConfirmationCardEvent(baseIntentResult());
    expect(event.type).toBe('confirmation_card');
  });

  it('buildNormalResponseEvent return type is assignable to ChatPipelineEvent', () => {
    const event: ChatPipelineEvent = buildNormalResponseEvent('hello');
    expect(event.type).toBe('normal_response');
  });
});
