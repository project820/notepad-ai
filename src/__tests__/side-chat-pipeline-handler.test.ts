/**
 * side-chat-pipeline-handler.test.ts
 *
 * Unit tests for `sideChatMessagePipelineHandler(message, emitter)`.
 *
 * Sub-AC 6c-ii requirements:
 *   ✓ Handler calls the intent detector
 *   ✓ Structural intent branch → emits ConfirmationCardEvent ('confirmation_card')
 *   ✓ Normal intent branch     → emits NormalResponseEvent   ('normal_response')
 *   ✓ No cross-branch leakage  — wrong event type is never emitted on either branch
 *   ✓ Emitter is called exactly once per invocation
 *
 * Strategy:
 *   The intent detector (detectOutlineDraftIntent) is mocked via vi.mock so that
 *   each branch can be exercised independently without relying on the real regex
 *   engine.  This isolates the handler's routing logic from the detector's
 *   classification logic, which is tested separately in outline-draft-intent.test.ts.
 *
 * Test groups:
 *   A. Structural intent branch — confirmation_card event emitted
 *   B. Normal intent branch     — normal_response event emitted
 *   C. Cross-branch leakage     — wrong event type never emitted
 *   D. Emitter call count       — emitter called exactly once per invocation
 *   E. Intent detector interaction — handler calls detector with correct message
 *   F. Event payload correctness  — emitted events carry expected data
 *   G. Edge cases                 — empty string, whitespace, long messages
 *   H. PipelineEmitter type       — emitter signature correctness
 */

import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

// ---------------------------------------------------------------------------
// Module mock — must be hoisted before the import of the module under test
// ---------------------------------------------------------------------------

vi.mock('../renderer/outline-draft-intent', () => ({
  detectOutlineDraftIntent: vi.fn(),
}));

// Import after vi.mock so the mock is in place
import {
  sideChatMessagePipelineHandler,
  type PipelineEmitter,
} from '../renderer/side-chat-pipeline-handler';

import {
  detectOutlineDraftIntent,
} from '../renderer/outline-draft-intent';

import type { ChatPipelineEvent } from '../renderer/chat-pipeline-events';
import type { OutlineDraftIntentResult } from '../renderer/outline-draft-intent';

// ---------------------------------------------------------------------------
// Typed mock reference
// ---------------------------------------------------------------------------

const mockDetect = detectOutlineDraftIntent as MockedFunction<typeof detectOutlineDraftIntent>;

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

/** Intent result that triggers the structural (Outline→Draft) branch. */
const STRUCTURAL_INTENT: OutlineDraftIntentResult = {
  isOutlineDraft: true,
  confidence: 0.9,
  signals: ['exact_trigger'],
};

/** Intent result that triggers the normal (flat QA) branch. */
const NORMAL_INTENT: OutlineDraftIntentResult = {
  isOutlineDraft: false,
  confidence: 0.1,
  signals: [],
};

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// A. Structural intent branch — confirmation_card event emitted
// ---------------------------------------------------------------------------

describe('A: structural intent branch → confirmation_card event', () => {
  beforeEach(() => {
    mockDetect.mockReturnValue(STRUCTURAL_INTENT);
  });

  it('emits an event with type "confirmation_card" when intent is structural', () => {
    let received: ChatPipelineEvent | undefined;
    sideChatMessagePipelineHandler('draft each section', (evt) => { received = evt; });
    expect(received?.type).toBe('confirmation_card');
  });

  it('emitted event has a non-null card property', () => {
    let received: ChatPipelineEvent | undefined;
    sideChatMessagePipelineHandler('fill in the sections', (evt) => { received = evt; });
    expect(received?.type).toBe('confirmation_card');
    if (received?.type === 'confirmation_card') {
      expect(received.card).toBeDefined();
      expect(received.card).not.toBeNull();
    }
  });

  it('emitted card has a non-empty title', () => {
    let received: ChatPipelineEvent | undefined;
    sideChatMessagePipelineHandler('write each section', (evt) => { received = evt; });
    if (received?.type === 'confirmation_card') {
      expect(typeof received.card.title).toBe('string');
      expect(received.card.title.length).toBeGreaterThan(0);
    }
  });

  it('emitted card has at least one action', () => {
    let received: ChatPipelineEvent | undefined;
    sideChatMessagePipelineHandler('draft the sections', (evt) => { received = evt; });
    if (received?.type === 'confirmation_card') {
      expect(Array.isArray(received.card.actions)).toBe(true);
      expect(received.card.actions.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('emitted event carries confidence from the intent result', () => {
    mockDetect.mockReturnValue({ ...STRUCTURAL_INTENT, confidence: 0.85 });
    let received: ChatPipelineEvent | undefined;
    sideChatMessagePipelineHandler('outline → draft', (evt) => { received = evt; });
    if (received?.type === 'confirmation_card') {
      expect(received.confidence).toBe(0.85);
    }
  });

  it('emitted event carries signals from the intent result', () => {
    const signals = ['exact_trigger', 'section_scope_en'];
    mockDetect.mockReturnValue({ ...STRUCTURAL_INTENT, signals });
    let received: ChatPipelineEvent | undefined;
    sideChatMessagePipelineHandler('draft each section', (evt) => { received = evt; });
    if (received?.type === 'confirmation_card') {
      expect(received.signals).toEqual(signals);
    }
  });

  it('emits confirmation_card regardless of the message content (routing is intent-driven)', () => {
    // The mock always returns structural intent; the specific message text is irrelevant
    const messages = [
      'draft each section',
      '각 섹션을 작성해줘',
      'outline → draft please',
      'expand the outline into a document',
      'fill in the body for every heading',
    ];
    for (const msg of messages) {
      let received: ChatPipelineEvent | undefined;
      sideChatMessagePipelineHandler(msg, (evt) => { received = evt; });
      expect(received?.type).toBe('confirmation_card');
    }
  });

  it('emitted event is assignable to ChatPipelineEvent union (structural check)', () => {
    let received: ChatPipelineEvent | undefined;
    sideChatMessagePipelineHandler('draft each section', (evt) => { received = evt; });
    // Type-guard: accessing 'card' only after confirming type
    if (received?.type === 'confirmation_card') {
      // card, confidence, signals are accessible
      expect(received.card).toBeDefined();
      expect(typeof received.confidence).toBe('number');
      expect(Array.isArray(received.signals)).toBe(true);
    } else {
      throw new Error('Expected confirmation_card branch');
    }
  });
});

// ---------------------------------------------------------------------------
// B. Normal intent branch — normal_response event emitted
// ---------------------------------------------------------------------------

describe('B: normal intent branch → normal_response event', () => {
  beforeEach(() => {
    mockDetect.mockReturnValue(NORMAL_INTENT);
  });

  it('emits an event with type "normal_response" when intent is normal', () => {
    let received: ChatPipelineEvent | undefined;
    sideChatMessagePipelineHandler('What do you think about the structure?', (evt) => { received = evt; });
    expect(received?.type).toBe('normal_response');
  });

  it('emitted event message field equals the input message', () => {
    const msg = 'Can you review this document?';
    let received: ChatPipelineEvent | undefined;
    sideChatMessagePipelineHandler(msg, (evt) => { received = evt; });
    if (received?.type === 'normal_response') {
      expect(received.message).toBe(msg);
    }
  });

  it('emitted event message is preserved verbatim (including whitespace)', () => {
    const msg = '  spaced message  ';
    let received: ChatPipelineEvent | undefined;
    sideChatMessagePipelineHandler(msg, (evt) => { received = evt; });
    if (received?.type === 'normal_response') {
      expect(received.message).toBe(msg);
    }
  });

  it('emitted event message is preserved for Korean text', () => {
    const msg = '이 구조 어떻게 생각해요?';
    let received: ChatPipelineEvent | undefined;
    sideChatMessagePipelineHandler(msg, (evt) => { received = evt; });
    if (received?.type === 'normal_response') {
      expect(received.message).toBe(msg);
    }
  });

  it('emits normal_response regardless of the message content (routing is intent-driven)', () => {
    const messages = [
      'What do you think?',
      '이 문서 검토해줘',
      'please review my outline',
      '',
    ];
    for (const msg of messages) {
      let received: ChatPipelineEvent | undefined;
      sideChatMessagePipelineHandler(msg, (evt) => { received = evt; });
      expect(received?.type).toBe('normal_response');
    }
  });

  it('emitted event is assignable to ChatPipelineEvent union (structural check)', () => {
    let received: ChatPipelineEvent | undefined;
    sideChatMessagePipelineHandler('hello world', (evt) => { received = evt; });
    if (received?.type === 'normal_response') {
      // message is accessible
      expect(typeof received.message).toBe('string');
    } else {
      throw new Error('Expected normal_response branch');
    }
  });

  it('different messages produce independent events with correct messages', () => {
    const results: ChatPipelineEvent[] = [];
    sideChatMessagePipelineHandler('first message', (evt) => results.push(evt));
    sideChatMessagePipelineHandler('second message', (evt) => results.push(evt));

    expect(results[0].type).toBe('normal_response');
    expect(results[1].type).toBe('normal_response');
    if (results[0].type === 'normal_response' && results[1].type === 'normal_response') {
      expect(results[0].message).toBe('first message');
      expect(results[1].message).toBe('second message');
    }
  });
});

// ---------------------------------------------------------------------------
// C. Cross-branch leakage — wrong event type never emitted on either branch
// ---------------------------------------------------------------------------

describe('C: cross-branch leakage — no wrong event type emitted', () => {
  it('structural branch does NOT emit normal_response', () => {
    mockDetect.mockReturnValue(STRUCTURAL_INTENT);
    let received: ChatPipelineEvent | undefined;
    sideChatMessagePipelineHandler('draft each section', (evt) => { received = evt; });
    expect(received?.type).not.toBe('normal_response');
  });

  it('normal branch does NOT emit confirmation_card', () => {
    mockDetect.mockReturnValue(NORMAL_INTENT);
    let received: ChatPipelineEvent | undefined;
    sideChatMessagePipelineHandler('What do you think?', (evt) => { received = evt; });
    expect(received?.type).not.toBe('confirmation_card');
  });

  it('structural branch does NOT produce a message field on the event', () => {
    mockDetect.mockReturnValue(STRUCTURAL_INTENT);
    let received: ChatPipelineEvent | undefined;
    sideChatMessagePipelineHandler('draft each section', (evt) => { received = evt; });
    // ConfirmationCardEvent should not have a 'message' property
    expect('message' in (received as object)).toBe(false);
  });

  it('normal branch does NOT produce a card field on the event', () => {
    mockDetect.mockReturnValue(NORMAL_INTENT);
    let received: ChatPipelineEvent | undefined;
    sideChatMessagePipelineHandler('What do you think?', (evt) => { received = evt; });
    // NormalResponseEvent should not have a 'card' property
    expect('card' in (received as object)).toBe(false);
  });

  it('normal branch does NOT produce a confidence field on the event', () => {
    mockDetect.mockReturnValue(NORMAL_INTENT);
    let received: ChatPipelineEvent | undefined;
    sideChatMessagePipelineHandler('review this', (evt) => { received = evt; });
    expect('confidence' in (received as object)).toBe(false);
  });

  it('normal branch does NOT produce a signals field on the event', () => {
    mockDetect.mockReturnValue(NORMAL_INTENT);
    let received: ChatPipelineEvent | undefined;
    sideChatMessagePipelineHandler('feedback please', (evt) => { received = evt; });
    expect('signals' in (received as object)).toBe(false);
  });

  it('interleaved calls: structural then normal produce correct types with no leakage', () => {
    const results: ChatPipelineEvent[] = [];

    mockDetect.mockReturnValueOnce(STRUCTURAL_INTENT);
    sideChatMessagePipelineHandler('draft each section', (evt) => results.push(evt));

    mockDetect.mockReturnValueOnce(NORMAL_INTENT);
    sideChatMessagePipelineHandler('what do you think?', (evt) => results.push(evt));

    expect(results[0].type).toBe('confirmation_card');
    expect(results[1].type).toBe('normal_response');

    // Verify structural event fields do not bleed into normal event
    expect('card' in results[1]).toBe(false);
    expect('confidence' in results[1]).toBe(false);

    // Verify normal event fields do not bleed into structural event
    expect('message' in results[0]).toBe(false);
  });

  it('interleaved calls: normal then structural produce correct types with no leakage', () => {
    const results: ChatPipelineEvent[] = [];

    mockDetect.mockReturnValueOnce(NORMAL_INTENT);
    sideChatMessagePipelineHandler('review my outline', (evt) => results.push(evt));

    mockDetect.mockReturnValueOnce(STRUCTURAL_INTENT);
    sideChatMessagePipelineHandler('fill in the sections', (evt) => results.push(evt));

    expect(results[0].type).toBe('normal_response');
    expect(results[1].type).toBe('confirmation_card');

    expect('card' in results[0]).toBe(false);
    expect('message' in results[1]).toBe(false);
  });

  it('multiple structural calls produce only confirmation_card events', () => {
    mockDetect.mockReturnValue(STRUCTURAL_INTENT);
    const types: string[] = [];
    for (let i = 0; i < 5; i++) {
      sideChatMessagePipelineHandler(`draft call ${i}`, (evt) => types.push(evt.type));
    }
    expect(types.every((t) => t === 'confirmation_card')).toBe(true);
  });

  it('multiple normal calls produce only normal_response events', () => {
    mockDetect.mockReturnValue(NORMAL_INTENT);
    const types: string[] = [];
    for (let i = 0; i < 5; i++) {
      sideChatMessagePipelineHandler(`normal call ${i}`, (evt) => types.push(evt.type));
    }
    expect(types.every((t) => t === 'normal_response')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// D. Emitter call count — called exactly once per invocation
// ---------------------------------------------------------------------------

describe('D: emitter called exactly once per handler invocation', () => {
  it('emitter is called exactly once for structural intent', () => {
    mockDetect.mockReturnValue(STRUCTURAL_INTENT);
    const spy = vi.fn<[ChatPipelineEvent], void>();
    sideChatMessagePipelineHandler('draft each section', spy);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('emitter is called exactly once for normal intent', () => {
    mockDetect.mockReturnValue(NORMAL_INTENT);
    const spy = vi.fn<[ChatPipelineEvent], void>();
    sideChatMessagePipelineHandler('What do you think?', spy);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('emitter is called exactly once even for empty string input', () => {
    mockDetect.mockReturnValue(NORMAL_INTENT);
    const spy = vi.fn<[ChatPipelineEvent], void>();
    sideChatMessagePipelineHandler('', spy);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('emitter is called exactly once for very long message', () => {
    mockDetect.mockReturnValue(NORMAL_INTENT);
    const long = 'word '.repeat(1000).trim();
    const spy = vi.fn<[ChatPipelineEvent], void>();
    sideChatMessagePipelineHandler(long, spy);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('two independent handler calls produce two separate emitter invocations', () => {
    const spy = vi.fn<[ChatPipelineEvent], void>();
    mockDetect.mockReturnValueOnce(STRUCTURAL_INTENT);
    sideChatMessagePipelineHandler('draft sections', spy);
    mockDetect.mockReturnValueOnce(NORMAL_INTENT);
    sideChatMessagePipelineHandler('review please', spy);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('emitter receives the event as the sole argument', () => {
    mockDetect.mockReturnValue(NORMAL_INTENT);
    const spy = vi.fn<[ChatPipelineEvent], void>();
    sideChatMessagePipelineHandler('test message', spy);
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ type: 'normal_response' }));
  });
});

// ---------------------------------------------------------------------------
// E. Intent detector interaction — handler calls detector with correct message
// ---------------------------------------------------------------------------

describe('E: intent detector called with correct message', () => {
  it('calls detectOutlineDraftIntent with the exact message string', () => {
    mockDetect.mockReturnValue(NORMAL_INTENT);
    const msg = 'What do you think about this?';
    sideChatMessagePipelineHandler(msg, () => {});
    expect(mockDetect).toHaveBeenCalledWith(msg);
  });

  it('calls detectOutlineDraftIntent with empty string without modification', () => {
    mockDetect.mockReturnValue(NORMAL_INTENT);
    sideChatMessagePipelineHandler('', () => {});
    expect(mockDetect).toHaveBeenCalledWith('');
  });

  it('calls detectOutlineDraftIntent with leading/trailing whitespace preserved', () => {
    mockDetect.mockReturnValue(NORMAL_INTENT);
    const msg = '  padded message  ';
    sideChatMessagePipelineHandler(msg, () => {});
    expect(mockDetect).toHaveBeenCalledWith(msg);
  });

  it('calls detectOutlineDraftIntent exactly once per handler call', () => {
    mockDetect.mockReturnValue(NORMAL_INTENT);
    sideChatMessagePipelineHandler('hello', () => {});
    expect(mockDetect).toHaveBeenCalledTimes(1);
  });

  it('calls detectOutlineDraftIntent before calling emitter', () => {
    const callOrder: string[] = [];
    mockDetect.mockImplementation((msg) => {
      callOrder.push('detect');
      return STRUCTURAL_INTENT;
    });
    sideChatMessagePipelineHandler('draft each section', () => {
      callOrder.push('emit');
    });
    expect(callOrder).toEqual(['detect', 'emit']);
  });

  it('uses the return value of detectOutlineDraftIntent for routing', () => {
    // First call: structural — emitter should get confirmation_card
    mockDetect.mockReturnValueOnce(STRUCTURAL_INTENT);
    let firstType: string | undefined;
    sideChatMessagePipelineHandler('same message', (evt) => { firstType = evt.type; });

    // Second call: normal — emitter should get normal_response
    mockDetect.mockReturnValueOnce(NORMAL_INTENT);
    let secondType: string | undefined;
    sideChatMessagePipelineHandler('same message', (evt) => { secondType = evt.type; });

    expect(firstType).toBe('confirmation_card');
    expect(secondType).toBe('normal_response');
  });
});

// ---------------------------------------------------------------------------
// F. Event payload correctness — emitted events carry expected data
// ---------------------------------------------------------------------------

describe('F: event payload correctness', () => {
  it('confirmation_card event confidence matches detector output', () => {
    mockDetect.mockReturnValue({ ...STRUCTURAL_INTENT, confidence: 0.95 });
    let received: ChatPipelineEvent | undefined;
    sideChatMessagePipelineHandler('draft each section', (evt) => { received = evt; });
    if (received?.type === 'confirmation_card') {
      expect(received.confidence).toBe(0.95);
    } else {
      throw new Error('Expected confirmation_card');
    }
  });

  it('confirmation_card event signals match detector output', () => {
    const signals = ['exact_trigger', 'section_scope_en'];
    mockDetect.mockReturnValue({ ...STRUCTURAL_INTENT, signals });
    let received: ChatPipelineEvent | undefined;
    sideChatMessagePipelineHandler('draft each section', (evt) => { received = evt; });
    if (received?.type === 'confirmation_card') {
      expect(received.signals).toEqual(signals);
    } else {
      throw new Error('Expected confirmation_card');
    }
  });

  it('normal_response event message equals raw input string', () => {
    const raw = 'This is my exact message to the AI.';
    mockDetect.mockReturnValue(NORMAL_INTENT);
    let received: ChatPipelineEvent | undefined;
    sideChatMessagePipelineHandler(raw, (evt) => { received = evt; });
    if (received?.type === 'normal_response') {
      expect(received.message).toBe(raw);
    } else {
      throw new Error('Expected normal_response');
    }
  });

  it('normal_response message is not modified or trimmed', () => {
    const raw = '   needs full whitespace   ';
    mockDetect.mockReturnValue(NORMAL_INTENT);
    let received: ChatPipelineEvent | undefined;
    sideChatMessagePipelineHandler(raw, (evt) => { received = evt; });
    if (received?.type === 'normal_response') {
      expect(received.message).toBe(raw);
    }
  });

  it('confirmation_card card has start and cancel actions (English default)', () => {
    mockDetect.mockReturnValue(STRUCTURAL_INTENT);
    let received: ChatPipelineEvent | undefined;
    sideChatMessagePipelineHandler('draft each section', (evt) => { received = evt; });
    if (received?.type === 'confirmation_card') {
      const ids = received.card.actions.map((a) => a.id);
      expect(ids).toContain('start');
      expect(ids).toContain('cancel');
    }
  });

  it('confirmation_card has English title by default (no language passed to handler)', () => {
    mockDetect.mockReturnValue(STRUCTURAL_INTENT);
    let received: ChatPipelineEvent | undefined;
    sideChatMessagePipelineHandler('please draft the outline', (evt) => { received = evt; });
    if (received?.type === 'confirmation_card') {
      // Default language is English
      expect(received.card.title).toBe('Start Outline→Draft?');
    }
  });
});

// ---------------------------------------------------------------------------
// G. Edge cases — empty string, whitespace, long messages
// ---------------------------------------------------------------------------

describe('G: edge cases', () => {
  it('empty string input: detector called, normal_response emitted (detector mocked to normal)', () => {
    mockDetect.mockReturnValue(NORMAL_INTENT);
    let received: ChatPipelineEvent | undefined;
    sideChatMessagePipelineHandler('', (evt) => { received = evt; });
    expect(mockDetect).toHaveBeenCalledWith('');
    expect(received?.type).toBe('normal_response');
  });

  it('whitespace-only input: detector called with whitespace, normal_response emitted', () => {
    mockDetect.mockReturnValue(NORMAL_INTENT);
    let received: ChatPipelineEvent | undefined;
    sideChatMessagePipelineHandler('   ', (evt) => { received = evt; });
    expect(mockDetect).toHaveBeenCalledWith('   ');
    expect(received?.type).toBe('normal_response');
  });

  it('very long message: processes without error for structural intent', () => {
    mockDetect.mockReturnValue(STRUCTURAL_INTENT);
    const long = 'draft each section '.repeat(500).trim();
    let received: ChatPipelineEvent | undefined;
    expect(() => {
      sideChatMessagePipelineHandler(long, (evt) => { received = evt; });
    }).not.toThrow();
    expect(received?.type).toBe('confirmation_card');
  });

  it('very long message: processes without error for normal intent', () => {
    mockDetect.mockReturnValue(NORMAL_INTENT);
    const long = 'word '.repeat(2000).trim();
    let received: ChatPipelineEvent | undefined;
    expect(() => {
      sideChatMessagePipelineHandler(long, (evt) => { received = evt; });
    }).not.toThrow();
    expect(received?.type).toBe('normal_response');
    if (received?.type === 'normal_response') {
      expect(received.message).toBe(long);
    }
  });

  it('Korean message: detector called, structural intent emitted correctly', () => {
    mockDetect.mockReturnValue({ ...STRUCTURAL_INTENT, signals: ['exact_trigger'] });
    const msg = '각 섹션을 작성해줘';
    let received: ChatPipelineEvent | undefined;
    sideChatMessagePipelineHandler(msg, (evt) => { received = evt; });
    expect(mockDetect).toHaveBeenCalledWith(msg);
    expect(received?.type).toBe('confirmation_card');
  });

  it('Korean message: detector called, normal intent emitted correctly', () => {
    mockDetect.mockReturnValue(NORMAL_INTENT);
    const msg = '이 구조 어떻게 생각해요?';
    let received: ChatPipelineEvent | undefined;
    sideChatMessagePipelineHandler(msg, (evt) => { received = evt; });
    expect(received?.type).toBe('normal_response');
    if (received?.type === 'normal_response') {
      expect(received.message).toBe(msg);
    }
  });

  it('handler does not throw when emitter is a no-op function', () => {
    mockDetect.mockReturnValue(STRUCTURAL_INTENT);
    expect(() => {
      sideChatMessagePipelineHandler('draft each section', () => {});
    }).not.toThrow();
  });

  it('isOutlineDraft boundary: exactly false routes to normal_response', () => {
    mockDetect.mockReturnValue({ isOutlineDraft: false, confidence: 0.59, signals: ['draft_verb_en'] });
    let received: ChatPipelineEvent | undefined;
    sideChatMessagePipelineHandler('draft something', (evt) => { received = evt; });
    expect(received?.type).toBe('normal_response');
  });

  it('isOutlineDraft boundary: exactly true routes to confirmation_card', () => {
    mockDetect.mockReturnValue({ isOutlineDraft: true, confidence: 0.60, signals: ['draft_verb_en', 'section_scope_en'] });
    let received: ChatPipelineEvent | undefined;
    sideChatMessagePipelineHandler('draft the sections of the document', (evt) => { received = evt; });
    expect(received?.type).toBe('confirmation_card');
  });
});

// ---------------------------------------------------------------------------
// H. PipelineEmitter type — emitter signature correctness
// ---------------------------------------------------------------------------

describe('H: PipelineEmitter type conformance', () => {
  it('PipelineEmitter accepts a ChatPipelineEvent and returns void', () => {
    // This test validates the TypeScript type at compile time.
    // The emitter must accept any ChatPipelineEvent variant.
    const emitter: PipelineEmitter = (event: ChatPipelineEvent): void => {
      expect(event).toBeDefined();
    };
    mockDetect.mockReturnValue(NORMAL_INTENT);
    sideChatMessagePipelineHandler('test', emitter);
  });

  it('PipelineEmitter works as an arrow function', () => {
    mockDetect.mockReturnValue(STRUCTURAL_INTENT);
    const captured: ChatPipelineEvent[] = [];
    const emitter: PipelineEmitter = (evt) => captured.push(evt);
    sideChatMessagePipelineHandler('draft sections', emitter);
    expect(captured.length).toBe(1);
    expect(captured[0].type).toBe('confirmation_card');
  });

  it('PipelineEmitter works as a named function', () => {
    mockDetect.mockReturnValue(NORMAL_INTENT);
    const captured: ChatPipelineEvent[] = [];

    function collectEvent(evt: ChatPipelineEvent): void {
      captured.push(evt);
    }

    sideChatMessagePipelineHandler('review this', collectEvent);
    expect(captured.length).toBe(1);
    expect(captured[0].type).toBe('normal_response');
  });

  it('emitter receives a properly-typed ChatPipelineEvent (not undefined)', () => {
    mockDetect.mockReturnValue(STRUCTURAL_INTENT);
    let receivedDefined = false;
    const emitter: PipelineEmitter = (evt) => {
      receivedDefined = evt !== undefined && evt !== null;
    };
    sideChatMessagePipelineHandler('draft each section', emitter);
    expect(receivedDefined).toBe(true);
  });
});
