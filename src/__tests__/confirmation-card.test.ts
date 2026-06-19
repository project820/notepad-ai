/**
 * confirmation-card.test.ts
 *
 * Unit tests for the ConfirmationCard data model and factory:
 *   - `CardActionSchema`        — Zod runtime validator for CardAction
 *   - `ConfirmationCardSchema`  — Zod runtime validator for ConfirmationCard
 *   - `parseConfirmationCard`   — helper wrapper around safeParse
 *   - TypeScript interfaces     — structural compatibility verified via
 *                                  conforming literals assigned to typed variables
 *   - `buildConfirmationCard`   — factory mapping IntentContext → ConfirmationCard
 *
 * Test matrix:
 *   1. Valid CardAction shapes — all fields, required only, optional variant values
 *   2. Invalid CardAction shapes — missing id/label, empty strings, wrong types,
 *      invalid variant literal
 *   3. Valid ConfirmationCard shapes — full, minimal, empty description,
 *      multiple actions
 *   4. Invalid ConfirmationCard shapes — missing title/description/actions,
 *      empty title, empty actions array, wrong field types, extra-field pass-through
 *   5. parseConfirmationCard — success path returns { success: true, data },
 *      failure path returns { success: false, error } with ZodError issues
 *   6. Interface structural checks — TypeScript-level conformance
 *   7. buildConfirmationCard — intent type 'outline_draft', English variants
 *   8. buildConfirmationCard — intent type 'outline_draft', Korean variants
 *   9. buildConfirmationCard — optional field combinations (headingCount / documentTitle)
 *  10. buildConfirmationCard — all returned cards pass ConfirmationCardSchema
 *  11. buildConfirmationCard — action structure (id / label / variant)
 *  12. buildConfirmationCard — default language fallback and edge cases
 */

import { describe, it, expect } from 'vitest';
import {
  CardActionSchema,
  ConfirmationCardSchema,
  parseConfirmationCard,
  buildConfirmationCard,
  type CardAction,
  type ConfirmationCard,
  type ConfirmationCardParseResult,
  type IntentContext,
  type IntentType,
} from '../renderer/confirmation-card';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseAction(input: unknown) {
  return CardActionSchema.safeParse(input);
}

function parseCard(input: unknown) {
  return ConfirmationCardSchema.safeParse(input);
}

// ---------------------------------------------------------------------------
// 1. Valid CardAction shapes
// ---------------------------------------------------------------------------

describe('CardActionSchema — valid shapes', () => {
  it('accepts a minimal CardAction with only required fields', () => {
    const result = parseAction({ id: 'confirm', label: 'Confirm' });
    expect(result.success).toBe(true);
  });

  it('accepts a CardAction with variant "primary"', () => {
    const result = parseAction({ id: 'start', label: 'Start', variant: 'primary' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.variant).toBe('primary');
    }
  });

  it('accepts a CardAction with variant "secondary"', () => {
    const result = parseAction({ id: 'cancel', label: 'Cancel', variant: 'secondary' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.variant).toBe('secondary');
    }
  });

  it('accepts a CardAction with variant "danger"', () => {
    const result = parseAction({ id: 'delete', label: 'Delete', variant: 'danger' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.variant).toBe('danger');
    }
  });

  it('accepts a CardAction with variant omitted (optional field)', () => {
    const result = parseAction({ id: 'ok', label: 'OK' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.variant).toBeUndefined();
    }
  });

  it('parses data correctly — returned data matches input', () => {
    const input = { id: 'approve', label: 'Approve', variant: 'primary' as const };
    const result = parseAction(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual(input);
    }
  });

  it('accepts id and label with whitespace inside (only leading/trailing empty is rejected)', () => {
    const result = parseAction({ id: 'my action', label: 'My Label Here' });
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. Invalid CardAction shapes
// ---------------------------------------------------------------------------

describe('CardActionSchema — invalid shapes', () => {
  it('rejects missing id field', () => {
    const result = parseAction({ label: 'Confirm' });
    expect(result.success).toBe(false);
  });

  it('rejects missing label field', () => {
    const result = parseAction({ id: 'confirm' });
    expect(result.success).toBe(false);
  });

  it('rejects missing both id and label', () => {
    const result = parseAction({ variant: 'primary' });
    expect(result.success).toBe(false);
  });

  it('rejects empty string for id', () => {
    const result = parseAction({ id: '', label: 'Confirm' });
    expect(result.success).toBe(false);
    if (!result.success) {
      const fields = result.error.issues.map((i) => i.path.join('.'));
      expect(fields).toContain('id');
    }
  });

  it('rejects empty string for label', () => {
    const result = parseAction({ id: 'ok', label: '' });
    expect(result.success).toBe(false);
    if (!result.success) {
      const fields = result.error.issues.map((i) => i.path.join('.'));
      expect(fields).toContain('label');
    }
  });

  it('rejects numeric id', () => {
    const result = parseAction({ id: 123, label: 'Confirm' });
    expect(result.success).toBe(false);
  });

  it('rejects numeric label', () => {
    const result = parseAction({ id: 'ok', label: 42 });
    expect(result.success).toBe(false);
  });

  it('rejects boolean id', () => {
    const result = parseAction({ id: true, label: 'Go' });
    expect(result.success).toBe(false);
  });

  it('rejects null as the entire input', () => {
    const result = parseAction(null);
    expect(result.success).toBe(false);
  });

  it('rejects undefined as the entire input', () => {
    const result = parseAction(undefined);
    expect(result.success).toBe(false);
  });

  it('rejects an array as the entire input', () => {
    const result = parseAction([{ id: 'ok', label: 'OK' }]);
    expect(result.success).toBe(false);
  });

  it('rejects invalid variant literal', () => {
    const result = parseAction({ id: 'x', label: 'X', variant: 'warning' });
    expect(result.success).toBe(false);
    if (!result.success) {
      const fields = result.error.issues.map((i) => i.path.join('.'));
      expect(fields).toContain('variant');
    }
  });

  it('rejects numeric variant', () => {
    const result = parseAction({ id: 'x', label: 'X', variant: 1 });
    expect(result.success).toBe(false);
  });

  it('error object contains at least one issue on failure', () => {
    const result = parseAction({ id: '', label: '' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Valid ConfirmationCard shapes
// ---------------------------------------------------------------------------

describe('ConfirmationCardSchema — valid shapes', () => {
  it('accepts a minimal ConfirmationCard with one action', () => {
    const result = parseCard({
      title: 'Confirm',
      description: 'Are you sure?',
      actions: [{ id: 'yes', label: 'Yes' }],
    });
    expect(result.success).toBe(true);
  });

  it('accepts an empty description (non-required content)', () => {
    const result = parseCard({
      title: 'Start Outline→Draft?',
      description: '',
      actions: [{ id: 'start', label: 'Start', variant: 'primary' }],
    });
    expect(result.success).toBe(true);
  });

  it('accepts a card with two actions', () => {
    const result = parseCard({
      title: 'Start Outline→Draft?',
      description: 'AI will write body content for each section.',
      actions: [
        { id: 'start', label: 'Start', variant: 'primary' },
        { id: 'cancel', label: 'Cancel', variant: 'secondary' },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('accepts a card with three actions', () => {
    const result = parseCard({
      title: 'Review Outline',
      description: 'Choose how to proceed.',
      actions: [
        { id: 'start', label: 'Start Draft', variant: 'primary' },
        { id: 'edit', label: 'Edit Outline', variant: 'secondary' },
        { id: 'cancel', label: 'Cancel', variant: 'danger' },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('parses data correctly — returned object equals input', () => {
    const input = {
      title: 'Ready?',
      description: 'Confirm to proceed.',
      actions: [{ id: 'go', label: 'Go', variant: 'primary' as const }],
    };
    const result = parseCard(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual(input);
    }
  });

  it('accepts a bilingual card (Korean title/description)', () => {
    const result = parseCard({
      title: '아웃라인 작성 시작?',
      description: 'AI가 각 섹션의 본문을 자동으로 작성합니다.',
      actions: [
        { id: 'start', label: '시작', variant: 'primary' },
        { id: 'cancel', label: '취소', variant: 'secondary' },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('actions array with variant omitted for all actions is valid', () => {
    const result = parseCard({
      title: 'Confirm',
      description: '',
      actions: [
        { id: 'a', label: 'Action A' },
        { id: 'b', label: 'Action B' },
      ],
    });
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. Invalid ConfirmationCard shapes
// ---------------------------------------------------------------------------

describe('ConfirmationCardSchema — invalid shapes', () => {
  it('rejects missing title', () => {
    const result = parseCard({
      description: 'Missing title here',
      actions: [{ id: 'ok', label: 'OK' }],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const fields = result.error.issues.map((i) => i.path.join('.'));
      expect(fields).toContain('title');
    }
  });

  it('rejects empty string for title', () => {
    const result = parseCard({
      title: '',
      description: 'desc',
      actions: [{ id: 'ok', label: 'OK' }],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const fields = result.error.issues.map((i) => i.path.join('.'));
      expect(fields).toContain('title');
    }
  });

  it('rejects missing description', () => {
    const result = parseCard({
      title: 'Title',
      actions: [{ id: 'ok', label: 'OK' }],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const fields = result.error.issues.map((i) => i.path.join('.'));
      expect(fields).toContain('description');
    }
  });

  it('rejects missing actions field', () => {
    const result = parseCard({
      title: 'Title',
      description: 'desc',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const fields = result.error.issues.map((i) => i.path.join('.'));
      expect(fields).toContain('actions');
    }
  });

  it('rejects empty actions array (must have at least 1 action)', () => {
    const result = parseCard({
      title: 'Title',
      description: 'desc',
      actions: [],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const fields = result.error.issues.map((i) => i.path.join('.'));
      expect(fields).toContain('actions');
    }
  });

  it('rejects non-array for actions', () => {
    const result = parseCard({
      title: 'Title',
      description: 'desc',
      actions: 'not an array',
    });
    expect(result.success).toBe(false);
  });

  it('rejects numeric title', () => {
    const result = parseCard({
      title: 42,
      description: 'desc',
      actions: [{ id: 'ok', label: 'OK' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects numeric description', () => {
    const result = parseCard({
      title: 'Title',
      description: 99,
      actions: [{ id: 'ok', label: 'OK' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects null as the entire input', () => {
    const result = parseCard(null);
    expect(result.success).toBe(false);
  });

  it('rejects undefined as the entire input', () => {
    const result = parseCard(undefined);
    expect(result.success).toBe(false);
  });

  it('rejects a plain string as the entire input', () => {
    const result = parseCard('not a card');
    expect(result.success).toBe(false);
  });

  it('rejects an array as the entire input', () => {
    const result = parseCard([]);
    expect(result.success).toBe(false);
  });

  it('rejects a card with an invalid CardAction inside actions', () => {
    // One action has missing label — entire card should fail
    const result = parseCard({
      title: 'Title',
      description: 'desc',
      actions: [{ id: 'ok' }], // label missing
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      // Error path should point into the actions array
      const hasActionsPath = result.error.issues.some(
        (i) => Array.isArray(i.path) && i.path[0] === 'actions',
      );
      expect(hasActionsPath).toBe(true);
    }
  });

  it('rejects a card where one of multiple actions is invalid', () => {
    const result = parseCard({
      title: 'Title',
      description: 'desc',
      actions: [
        { id: 'ok', label: 'OK' },
        { id: '', label: 'Bad' }, // empty id
      ],
    });
    expect(result.success).toBe(false);
  });

  it('error object contains at least one issue on failure', () => {
    const result = parseCard({ title: '', description: '', actions: [] });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// 5. parseConfirmationCard helper
// ---------------------------------------------------------------------------

describe('parseConfirmationCard — success path', () => {
  it('returns { success: true, data } for a valid card', () => {
    const input = {
      title: 'Start Outline→Draft?',
      description: 'AI will write body content for each section.',
      actions: [
        { id: 'start', label: 'Start', variant: 'primary' as const },
        { id: 'cancel', label: 'Cancel', variant: 'secondary' as const },
      ],
    };
    const result: ConfirmationCardParseResult = parseConfirmationCard(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.title).toBe(input.title);
      expect(result.data.description).toBe(input.description);
      expect(result.data.actions).toHaveLength(2);
      expect(result.data.actions[0].id).toBe('start');
      expect(result.data.actions[1].id).toBe('cancel');
    }
  });

  it('returned data is structurally identical to input for valid card', () => {
    const input = {
      title: 'Confirm',
      description: '',
      actions: [{ id: 'go', label: 'Go' }],
    };
    const result = parseConfirmationCard(input);
    if (result.success) {
      expect(result.data).toEqual(input);
    } else {
      throw new Error('Expected success but got failure');
    }
  });

  it('success result does not have an error property', () => {
    const result = parseConfirmationCard({
      title: 'T',
      description: 'D',
      actions: [{ id: 'a', label: 'A' }],
    });
    expect(result.success).toBe(true);
    // TypeScript narrowing: on success there is no `error` property
    expect('error' in result).toBe(false);
  });
});

describe('parseConfirmationCard — failure path', () => {
  it('returns { success: false, error } for missing title', () => {
    const result = parseConfirmationCard({
      description: 'desc',
      actions: [{ id: 'ok', label: 'OK' }],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBeDefined();
      expect(result.error.issues.length).toBeGreaterThan(0);
    }
  });

  it('returns { success: false, error } for missing description', () => {
    const result = parseConfirmationCard({
      title: 'Title',
      actions: [{ id: 'ok', label: 'OK' }],
    });
    expect(result.success).toBe(false);
  });

  it('returns { success: false, error } for missing actions', () => {
    const result = parseConfirmationCard({ title: 'Title', description: 'D' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.length).toBeGreaterThan(0);
    }
  });

  it('returns { success: false, error } for empty actions array', () => {
    const result = parseConfirmationCard({
      title: 'Title',
      description: 'D',
      actions: [],
    });
    expect(result.success).toBe(false);
  });

  it('returns { success: false, error } for null input', () => {
    const result = parseConfirmationCard(null);
    expect(result.success).toBe(false);
  });

  it('returns { success: false, error } for undefined input', () => {
    const result = parseConfirmationCard(undefined);
    expect(result.success).toBe(false);
  });

  it('error has structured issues array (not a plain string)', () => {
    const result = parseConfirmationCard({ title: '', description: 'D', actions: [] });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(Array.isArray(result.error.issues)).toBe(true);
      // Each issue has a `message` field
      result.error.issues.forEach((issue) => {
        expect(typeof issue.message).toBe('string');
      });
    }
  });

  it('failure result does not have a data property', () => {
    const result = parseConfirmationCard(null);
    expect(result.success).toBe(false);
    expect('data' in result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 6. TypeScript interface structural checks
// ---------------------------------------------------------------------------
// These tests verify that the exported TypeScript interfaces accept conforming
// objects at the type level. Because TypeScript types are erased at runtime,
// we verify structural compatibility by assigning typed variables and checking
// that the assigned values pass schema validation — ensuring the interface and
// schema stay in sync.

describe('TypeScript interface structural compatibility', () => {
  it('CardAction interface: conforming object satisfies type and passes schema', () => {
    const action: CardAction = { id: 'ok', label: 'OK', variant: 'primary' };
    const result = CardActionSchema.safeParse(action);
    expect(result.success).toBe(true);
  });

  it('CardAction interface: minimal object (no variant) satisfies type and passes schema', () => {
    const action: CardAction = { id: 'next', label: 'Next' };
    const result = CardActionSchema.safeParse(action);
    expect(result.success).toBe(true);
  });

  it('ConfirmationCard interface: conforming object satisfies type and passes schema', () => {
    const card: ConfirmationCard = {
      title: 'Start?',
      description: 'AI will draft each section.',
      actions: [
        { id: 'start', label: 'Start', variant: 'primary' },
        { id: 'cancel', label: 'Cancel', variant: 'secondary' },
      ],
    };
    const result = ConfirmationCardSchema.safeParse(card);
    expect(result.success).toBe(true);
  });

  it('ConfirmationCard interface: interface-typed variable has expected property types at runtime', () => {
    const card: ConfirmationCard = {
      title: 'Confirm',
      description: '',
      actions: [{ id: 'go', label: 'Go' }],
    };
    expect(typeof card.title).toBe('string');
    expect(typeof card.description).toBe('string');
    expect(Array.isArray(card.actions)).toBe(true);
    expect(card.actions.length).toBe(1);
    expect(typeof card.actions[0].id).toBe('string');
    expect(typeof card.actions[0].label).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// Helpers for factory tests
// ---------------------------------------------------------------------------

/** Minimal valid IntentContext for 'outline_draft' (English, no optional fields). */
function baseCtx(overrides: Partial<IntentContext> = {}): IntentContext {
  return {
    type: 'outline_draft',
    message: 'Please draft each section',
    confidence: 0.9,
    signals: ['exact_trigger'],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 7. buildConfirmationCard — intent type 'outline_draft', English variants
// ---------------------------------------------------------------------------

describe("buildConfirmationCard — 'outline_draft' English (language: 'en')", () => {
  it("returns a ConfirmationCard for type 'outline_draft' with language 'en'", () => {
    const card = buildConfirmationCard(baseCtx({ language: 'en' }));
    expect(card).toBeDefined();
    expect(typeof card).toBe('object');
  });

  it('English card title is "Start Outline→Draft?"', () => {
    const card = buildConfirmationCard(baseCtx({ language: 'en' }));
    expect(card.title).toBe('Start Outline→Draft?');
  });

  it('English card description is a non-empty string', () => {
    const card = buildConfirmationCard(baseCtx({ language: 'en' }));
    expect(typeof card.description).toBe('string');
    expect(card.description.length).toBeGreaterThan(0);
  });

  it('English card description mentions "each section" when headingCount is absent', () => {
    const card = buildConfirmationCard(baseCtx({ language: 'en' }));
    expect(card.description).toContain('each section');
  });

  it('English card description mentions section count when headingCount = 4', () => {
    const card = buildConfirmationCard(baseCtx({ language: 'en', headingCount: 4 }));
    expect(card.description).toContain('4');
    expect(card.description).toContain('sections');
  });

  it('English card description uses singular "section" when headingCount = 1', () => {
    const card = buildConfirmationCard(baseCtx({ language: 'en', headingCount: 1 }));
    expect(card.description).toContain('1 section');
    expect(card.description).not.toContain('1 sections');
  });

  it('English card description includes documentTitle in quotes when provided', () => {
    const card = buildConfirmationCard(
      baseCtx({ language: 'en', documentTitle: 'Q3 Report' }),
    );
    expect(card.description).toContain('"Q3 Report"');
  });

  it('English card description omits doc reference when documentTitle is absent', () => {
    const card = buildConfirmationCard(baseCtx({ language: 'en' }));
    expect(card.description).not.toContain('"');
  });

  it('English card description includes headingCount AND documentTitle together', () => {
    const card = buildConfirmationCard(
      baseCtx({ language: 'en', headingCount: 7, documentTitle: 'Annual Plan' }),
    );
    expect(card.description).toContain('7');
    expect(card.description).toContain('"Annual Plan"');
  });

  it('English card has exactly 2 actions', () => {
    const card = buildConfirmationCard(baseCtx({ language: 'en' }));
    expect(card.actions).toHaveLength(2);
  });

  it('English card first action has id "start" and variant "primary"', () => {
    const card = buildConfirmationCard(baseCtx({ language: 'en' }));
    const [start] = card.actions;
    expect(start.id).toBe('start');
    expect(start.label).toBe('Start');
    expect(start.variant).toBe('primary');
  });

  it('English card second action has id "cancel" and variant "secondary"', () => {
    const card = buildConfirmationCard(baseCtx({ language: 'en' }));
    const [, cancel] = card.actions;
    expect(cancel.id).toBe('cancel');
    expect(cancel.label).toBe('Cancel');
    expect(cancel.variant).toBe('secondary');
  });
});

// ---------------------------------------------------------------------------
// 8. buildConfirmationCard — intent type 'outline_draft', Korean variants
// ---------------------------------------------------------------------------

describe("buildConfirmationCard — 'outline_draft' Korean (language: 'ko')", () => {
  it("returns a ConfirmationCard for type 'outline_draft' with language 'ko'", () => {
    const card = buildConfirmationCard(baseCtx({ language: 'ko' }));
    expect(card).toBeDefined();
    expect(typeof card).toBe('object');
  });

  it('Korean card title is "아웃라인 작성 시작할까요?"', () => {
    const card = buildConfirmationCard(baseCtx({ language: 'ko' }));
    expect(card.title).toBe('아웃라인 작성 시작할까요?');
  });

  it('Korean card description is a non-empty string', () => {
    const card = buildConfirmationCard(baseCtx({ language: 'ko' }));
    expect(typeof card.description).toBe('string');
    expect(card.description.length).toBeGreaterThan(0);
  });

  it('Korean card description mentions "각 섹션" when headingCount is absent', () => {
    const card = buildConfirmationCard(baseCtx({ language: 'ko' }));
    expect(card.description).toContain('각 섹션');
  });

  it('Korean card description includes section count when headingCount = 5', () => {
    const card = buildConfirmationCard(baseCtx({ language: 'ko', headingCount: 5 }));
    expect(card.description).toContain('5개 섹션');
  });

  it('Korean card description includes documentTitle in quotes when provided', () => {
    const card = buildConfirmationCard(
      baseCtx({ language: 'ko', documentTitle: '분기 보고서' }),
    );
    expect(card.description).toContain('"분기 보고서"');
  });

  it('Korean card description omits doc reference when documentTitle is absent', () => {
    const card = buildConfirmationCard(baseCtx({ language: 'ko' }));
    // Should not contain a quoted string
    expect(card.description).not.toMatch(/"[^"]+"/);
  });

  it('Korean card description includes headingCount AND documentTitle together', () => {
    const card = buildConfirmationCard(
      baseCtx({ language: 'ko', headingCount: 3, documentTitle: '연간 계획' }),
    );
    expect(card.description).toContain('3개 섹션');
    expect(card.description).toContain('"연간 계획"');
  });

  it('Korean card has exactly 2 actions', () => {
    const card = buildConfirmationCard(baseCtx({ language: 'ko' }));
    expect(card.actions).toHaveLength(2);
  });

  it('Korean card first action has id "start", label "시작", variant "primary"', () => {
    const card = buildConfirmationCard(baseCtx({ language: 'ko' }));
    const [start] = card.actions;
    expect(start.id).toBe('start');
    expect(start.label).toBe('시작');
    expect(start.variant).toBe('primary');
  });

  it('Korean card second action has id "cancel", label "취소", variant "secondary"', () => {
    const card = buildConfirmationCard(baseCtx({ language: 'ko' }));
    const [, cancel] = card.actions;
    expect(cancel.id).toBe('cancel');
    expect(cancel.label).toBe('취소');
    expect(cancel.variant).toBe('secondary');
  });
});

// ---------------------------------------------------------------------------
// 9. buildConfirmationCard — optional field combinations
// ---------------------------------------------------------------------------

describe('buildConfirmationCard — optional field combinations', () => {
  it('works with only required fields (no headingCount, no documentTitle, no language)', () => {
    const card = buildConfirmationCard(baseCtx());
    expect(card.title.length).toBeGreaterThan(0);
    expect(card.actions.length).toBeGreaterThanOrEqual(1);
  });

  it('headingCount = 0 is handled without crash', () => {
    const card = buildConfirmationCard(baseCtx({ language: 'en', headingCount: 0 }));
    expect(card.description).toContain('0');
    // Plural rule: 0 sections
    expect(card.description).toContain('sections');
  });

  it('headingCount = 0 Korean handled without crash', () => {
    const card = buildConfirmationCard(baseCtx({ language: 'ko', headingCount: 0 }));
    expect(card.description).toContain('0개 섹션');
  });

  it('documentTitle with special characters is safely embedded', () => {
    const card = buildConfirmationCard(
      baseCtx({ language: 'en', documentTitle: 'Quarterly "Review" & Planning' }),
    );
    expect(card.description).toContain('Quarterly "Review" & Planning');
  });

  it('documentTitle empty string is treated as absent (English)', () => {
    // Empty documentTitle should behave like no documentTitle
    const card = buildConfirmationCard(
      baseCtx({ language: 'en', documentTitle: '' }),
    );
    // Empty string is falsy — no doc phrase should appear
    expect(card.description).not.toMatch(/""/);
  });

  it('large headingCount is formatted correctly', () => {
    const card = buildConfirmationCard(
      baseCtx({ language: 'en', headingCount: 100 }),
    );
    expect(card.description).toContain('100 sections');
  });

  it('confidence and signals fields do not affect card content', () => {
    const card1 = buildConfirmationCard(
      baseCtx({ confidence: 0.6, signals: ['exact_trigger'] }),
    );
    const card2 = buildConfirmationCard(
      baseCtx({ confidence: 1.0, signals: ['draft_verb_en', 'section_scope_en'] }),
    );
    // Card content depends on type/language/headingCount/documentTitle only
    expect(card1.title).toBe(card2.title);
    expect(card1.description).toBe(card2.description);
    expect(card1.actions).toEqual(card2.actions);
  });

  it('message field does not affect card content', () => {
    const card1 = buildConfirmationCard(baseCtx({ message: 'draft each section' }));
    const card2 = buildConfirmationCard(
      baseCtx({ message: '각 섹션을 작성해줘', language: 'en' }),
    );
    expect(card1.title).toBe(card2.title);
  });
});

// ---------------------------------------------------------------------------
// 10. buildConfirmationCard — all returned cards pass ConfirmationCardSchema
// ---------------------------------------------------------------------------

describe('buildConfirmationCard — schema compliance', () => {
  const schemaVariants: Array<{ label: string; ctx: IntentContext }> = [
    {
      label: "outline_draft / en / no optional fields",
      ctx: baseCtx({ language: 'en' }),
    },
    {
      label: "outline_draft / en / headingCount=3",
      ctx: baseCtx({ language: 'en', headingCount: 3 }),
    },
    {
      label: "outline_draft / en / documentTitle present",
      ctx: baseCtx({ language: 'en', documentTitle: 'My Doc' }),
    },
    {
      label: "outline_draft / en / headingCount + documentTitle",
      ctx: baseCtx({ language: 'en', headingCount: 6, documentTitle: 'Sprint Plan' }),
    },
    {
      label: "outline_draft / ko / no optional fields",
      ctx: baseCtx({ language: 'ko' }),
    },
    {
      label: "outline_draft / ko / headingCount=2",
      ctx: baseCtx({ language: 'ko', headingCount: 2 }),
    },
    {
      label: "outline_draft / ko / documentTitle present",
      ctx: baseCtx({ language: 'ko', documentTitle: '보고서' }),
    },
    {
      label: "outline_draft / ko / headingCount + documentTitle",
      ctx: baseCtx({ language: 'ko', headingCount: 4, documentTitle: '연간 계획서' }),
    },
    {
      label: "outline_draft / language absent (defaults to en)",
      ctx: baseCtx(),
    },
    {
      label: "outline_draft / headingCount=1 singular",
      ctx: baseCtx({ language: 'en', headingCount: 1 }),
    },
    {
      label: "outline_draft / headingCount=0",
      ctx: baseCtx({ language: 'en', headingCount: 0 }),
    },
  ];

  for (const { label, ctx } of schemaVariants) {
    it(`passes ConfirmationCardSchema: ${label}`, () => {
      const card = buildConfirmationCard(ctx);
      const result = ConfirmationCardSchema.safeParse(card);
      expect(result.success).toBe(true);
    });
  }

  it('all schema-compliant results also pass parseConfirmationCard()', () => {
    for (const { ctx } of schemaVariants) {
      const card = buildConfirmationCard(ctx);
      const result = parseConfirmationCard(card);
      expect(result.success).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 11. buildConfirmationCard — action structure integrity
// ---------------------------------------------------------------------------

describe('buildConfirmationCard — action structure integrity', () => {
  it("every action has a non-empty 'id' string", () => {
    const card = buildConfirmationCard(baseCtx({ language: 'en' }));
    for (const action of card.actions) {
      expect(typeof action.id).toBe('string');
      expect(action.id.length).toBeGreaterThan(0);
    }
  });

  it("every action has a non-empty 'label' string", () => {
    const card = buildConfirmationCard(baseCtx({ language: 'en' }));
    for (const action of card.actions) {
      expect(typeof action.label).toBe('string');
      expect(action.label.length).toBeGreaterThan(0);
    }
  });

  it("every action's variant is one of 'primary' | 'secondary' | 'danger' or undefined", () => {
    const card = buildConfirmationCard(baseCtx({ language: 'en' }));
    const validVariants = ['primary', 'secondary', 'danger', undefined];
    for (const action of card.actions) {
      expect(validVariants).toContain(action.variant);
    }
  });

  it("actions array has unique 'id' values (no duplicates)", () => {
    const card = buildConfirmationCard(baseCtx({ language: 'en' }));
    const ids = card.actions.map((a) => a.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });

  it('Korean card action ids are identical to English (ids are language-agnostic)', () => {
    const enCard = buildConfirmationCard(baseCtx({ language: 'en' }));
    const koCard = buildConfirmationCard(baseCtx({ language: 'ko' }));
    expect(enCard.actions.map((a) => a.id)).toEqual(koCard.actions.map((a) => a.id));
  });

  it('Korean card action variants are identical to English', () => {
    const enCard = buildConfirmationCard(baseCtx({ language: 'en' }));
    const koCard = buildConfirmationCard(baseCtx({ language: 'ko' }));
    expect(enCard.actions.map((a) => a.variant)).toEqual(
      koCard.actions.map((a) => a.variant),
    );
  });

  it('each action satisfies CardActionSchema independently', () => {
    const card = buildConfirmationCard(baseCtx({ language: 'en' }));
    for (const action of card.actions) {
      const result = CardActionSchema.safeParse(action);
      expect(result.success).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 12. buildConfirmationCard — default language and edge cases
// ---------------------------------------------------------------------------

describe('buildConfirmationCard — default language and edge cases', () => {
  it('defaults to English when language field is omitted', () => {
    const cardWithoutLang = buildConfirmationCard(baseCtx());
    const cardWithEnLang = buildConfirmationCard(baseCtx({ language: 'en' }));
    expect(cardWithoutLang.title).toBe(cardWithEnLang.title);
    expect(cardWithoutLang.description).toBe(cardWithEnLang.description);
    expect(cardWithoutLang.actions).toEqual(cardWithEnLang.actions);
  });

  it('defaults to English when language is explicitly undefined', () => {
    const ctx: IntentContext = { ...baseCtx(), language: undefined };
    const card = buildConfirmationCard(ctx);
    expect(card.title).toBe('Start Outline→Draft?');
  });

  it("throws for an unrecognised intent type at runtime", () => {
    // @ts-expect-error — testing runtime guard with intentionally wrong type
    const badCtx: IntentContext = { ...baseCtx(), type: 'unknown_intent' };
    expect(() => buildConfirmationCard(badCtx)).toThrow(
      /unrecognised intent type/,
    );
  });

  it('returned card title is a non-empty string for every defined variant', () => {
    const types: IntentType[] = ['outline_draft'];
    const languages: Array<'en' | 'ko'> = ['en', 'ko'];
    for (const type of types) {
      for (const language of languages) {
        const card = buildConfirmationCard(baseCtx({ type, language }));
        expect(typeof card.title).toBe('string');
        expect(card.title.length).toBeGreaterThan(0);
      }
    }
  });

  it('returned card always has at least one action', () => {
    const cards = [
      buildConfirmationCard(baseCtx({ language: 'en' })),
      buildConfirmationCard(baseCtx({ language: 'ko' })),
      buildConfirmationCard(baseCtx({ language: 'en', headingCount: 3 })),
    ];
    for (const card of cards) {
      expect(card.actions.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('IntentContext type is a TypeScript-level type guard (structural check)', () => {
    // Assign a typed variable — TypeScript would error at compile time if wrong
    const ctx: IntentContext = {
      type: 'outline_draft',
      message: 'draft each section',
      confidence: 0.9,
      signals: ['exact_trigger'],
      headingCount: 3,
      documentTitle: 'My Document',
      language: 'en',
    };
    const card = buildConfirmationCard(ctx);
    expect(card).toBeDefined();
  });
});
