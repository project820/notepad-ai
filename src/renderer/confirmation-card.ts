/**
 * confirmation-card.ts
 *
 * Data model for the ConfirmationCard shown in Side Chat when the AI detects
 * an Outline→Draft intent from the user's natural-language message.
 *
 * The ConfirmationCard is the "intent_card" concept from the v1.1 ontology:
 * a structured UI element that asks the user to confirm before the agentic
 * Outline→Draft workflow mutates the document.
 *
 * This module provides:
 *  1. TypeScript interfaces  — `CardAction`, `ConfirmationCard`, `IntentContext`
 *  2. Zod v3 runtime schemas — `CardActionSchema` and `ConfirmationCardSchema`
 *  3. A thin `parseConfirmationCard` helper that wraps `safeParse` with a
 *     typed result so callers never import Zod directly.
 *  4. A `buildConfirmationCard` factory that maps every valid `IntentContext`
 *     variant to a correctly shaped `ConfirmationCard` payload.
 *
 * ROLLBACK SAFETY:
 *  - Pure module: zero imports from UI, Electron, or editor code.
 *  - No side effects, no global state.
 *  - Callers guard invocations behind the `outlineDraftEnabled` feature-toggle
 *    preference — this file itself has no awareness of that toggle.
 *  - Deleting all callers fully reverts ConfirmationCard behaviour.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// CardAction
// ---------------------------------------------------------------------------

/**
 * A single actionable button rendered inside a ConfirmationCard.
 *
 * `id`      — machine-readable identifier used by event handlers.
 * `label`   — human-readable button text shown to the user.
 * `variant` — optional visual style hint for the UI layer.
 *             Defaults to `'secondary'` when absent.
 */
export interface CardAction {
  id: string;
  label: string;
  variant?: 'primary' | 'secondary' | 'danger';
}

/**
 * Zod schema for `CardAction`.
 *
 * Invariants enforced at runtime:
 *  - `id`    must be a non-empty string (whitespace-only is rejected).
 *  - `label` must be a non-empty string (whitespace-only is rejected).
 *  - `variant` is optional; when present it must be one of the three literals.
 */
export const CardActionSchema: z.ZodType<CardAction> = z.object({
  id: z.string().min(1, 'CardAction.id must be a non-empty string'),
  label: z.string().min(1, 'CardAction.label must be a non-empty string'),
  variant: z.enum(['primary', 'secondary', 'danger']).optional(),
});

// ---------------------------------------------------------------------------
// ConfirmationCard
// ---------------------------------------------------------------------------

/**
 * The confirmation card displayed in Side Chat before the Outline→Draft
 * workflow begins.
 *
 * `title`       — short heading summarising what the AI is about to do.
 * `description` — longer explanatory text (may be empty for simple cards).
 * `actions`     — ordered list of action buttons; must contain ≥ 1 item
 *                 (a card with zero actions cannot be interacted with).
 */
export interface ConfirmationCard {
  title: string;
  description: string;
  actions: CardAction[];
}

/**
 * Zod schema for `ConfirmationCard`.
 *
 * Invariants enforced at runtime:
 *  - `title`       must be a non-empty string.
 *  - `description` must be a string (empty is allowed).
 *  - `actions`     must be an array with at least one `CardAction`.
 */
export const ConfirmationCardSchema: z.ZodType<ConfirmationCard> = z.object({
  title: z.string().min(1, 'ConfirmationCard.title must be a non-empty string'),
  description: z.string(),
  actions: z
    .array(CardActionSchema)
    .min(1, 'ConfirmationCard.actions must contain at least one action'),
});

// ---------------------------------------------------------------------------
// Parse helper
// ---------------------------------------------------------------------------

/** Discriminated-union result so callers avoid importing Zod directly. */
export type ConfirmationCardParseResult =
  | { success: true; data: ConfirmationCard }
  | { success: false; error: z.ZodError };

/**
 * Validates `unknown` input against `ConfirmationCardSchema`.
 *
 * Returns a discriminated-union result — callers must check `result.success`
 * before accessing `result.data`.  On failure `result.error` is a `ZodError`
 * with structured field-level messages.
 *
 * @param input - Any value to validate.
 * @returns `{ success: true, data }` or `{ success: false, error }`.
 *
 * @example
 * const result = parseConfirmationCard({
 *   title: 'Start Outline→Draft?',
 *   description: 'AI will write body content for each section.',
 *   actions: [
 *     { id: 'start', label: 'Start', variant: 'primary' },
 *     { id: 'cancel', label: 'Cancel', variant: 'secondary' },
 *   ],
 * });
 * if (result.success) {
 *   renderCard(result.data);
 * } else {
 *   console.error(result.error.issues);
 * }
 */
export function parseConfirmationCard(input: unknown): ConfirmationCardParseResult {
  const parsed = ConfirmationCardSchema.safeParse(input);
  if (parsed.success) {
    return { success: true, data: parsed.data };
  }
  return { success: false, error: parsed.error };
}

// ---------------------------------------------------------------------------
// IntentContext
// ---------------------------------------------------------------------------

/**
 * Discriminated intent type for `buildConfirmationCard`.
 *
 * Only `'outline_draft'` is defined for v1.1; the union is left open for
 * future extension without breaking existing callers.
 */
export type IntentType = 'outline_draft';

/**
 * Structured context produced by the intent-detection layer and optional
 * document-state metadata.  Passed to `buildConfirmationCard` to select and
 * populate the correct `ConfirmationCard` variant.
 *
 * `type`          — discriminant that selects the card variant; currently
 *                   only `'outline_draft'` is recognised.
 * `message`       — original user message that triggered the intent.
 * `confidence`    — normalised confidence score [0, 1] from intent detection.
 * `signals`       — human-readable labels of matched pattern groups (for
 *                   transparency; the factory does not use them for branching).
 * `headingCount`  — optional number of headings in the document; when
 *                   provided, the description names the exact count.
 * `documentTitle` — optional file/document name quoted in the description.
 * `language`      — UI language ('en' | 'ko'); defaults to `'en'` when
 *                   absent or undefined.
 */
export interface IntentContext {
  type: IntentType;
  message: string;
  confidence: number;
  signals: string[];
  headingCount?: number;
  documentTitle?: string;
  language?: 'en' | 'ko';
}

// ---------------------------------------------------------------------------
// buildConfirmationCard factory
// ---------------------------------------------------------------------------

/**
 * Maps every valid `IntentContext` variant to a correctly shaped
 * `ConfirmationCard` payload.
 *
 * The returned object always satisfies `ConfirmationCardSchema`.  Callers may
 * optionally run `parseConfirmationCard()` on the result for extra runtime
 * safety, but it is not required.
 *
 * Branching logic:
 *  - `type === 'outline_draft'` → Outline→Draft confirmation card.
 *  - Any unrecognised `type` value throws at runtime (TypeScript exhaustive
 *    check catches additions at compile time).
 *
 * @param intentContext - Structured intent context from the detection layer.
 * @returns A `ConfirmationCard` ready to render in the Side Chat panel.
 * @throws {Error} If `intentContext.type` is an unrecognised value at runtime.
 *
 * @example
 * const card = buildConfirmationCard({
 *   type: 'outline_draft',
 *   message: 'Please draft each section',
 *   confidence: 0.9,
 *   signals: ['exact_trigger'],
 *   headingCount: 5,
 *   language: 'en',
 * });
 * // → {
 * //     title: 'Start Outline→Draft?',
 * //     description: 'AI will write body content for your 5 sections. ...',
 * //     actions: [{ id: 'start', ... }, { id: 'cancel', ... }],
 * //   }
 */
export function buildConfirmationCard(intentContext: IntentContext): ConfirmationCard {
  const { type } = intentContext;

  switch (type) {
    case 'outline_draft':
      return _buildOutlineDraftCard(intentContext);

    default: {
      // TypeScript exhaustive check — adding a new IntentType without a
      // corresponding case will produce a compile-time error here.
      const _exhaustive: never = type;
      throw new Error(
        `buildConfirmationCard: unrecognised intent type "${String(_exhaustive)}"`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Private variant builders
// ---------------------------------------------------------------------------

/**
 * Dispatches to the language-specific builder for the 'outline_draft' variant.
 */
function _buildOutlineDraftCard(ctx: IntentContext): ConfirmationCard {
  const { headingCount, documentTitle, language = 'en' } = ctx;
  return language === 'ko'
    ? _buildOutlineDraftCardKo(headingCount, documentTitle)
    : _buildOutlineDraftCardEn(headingCount, documentTitle);
}

/**
 * English 'outline_draft' card.
 *
 * Title   : "Start Outline→Draft?"
 * Actions : Start (primary), Cancel (secondary)
 * Description varies by headingCount / documentTitle presence.
 */
function _buildOutlineDraftCardEn(
  headingCount: number | undefined,
  documentTitle: string | undefined,
): ConfirmationCard {
  const sectionPhrase =
    headingCount !== undefined
      ? `your ${headingCount} section${headingCount === 1 ? '' : 's'}`
      : 'each section';
  const docPhrase = documentTitle ? ` of "${documentTitle}"` : '';
  const description =
    `AI will write body content for ${sectionPhrase}${docPhrase}. ` +
    `You can review and accept or reject each section before it is inserted.`;

  return {
    title: 'Start Outline→Draft?',
    description,
    actions: [
      { id: 'start', label: 'Start', variant: 'primary' },
      { id: 'cancel', label: 'Cancel', variant: 'secondary' },
    ],
  };
}

/**
 * Korean 'outline_draft' card.
 *
 * Title   : "아웃라인 작성 시작할까요?"
 * Actions : 시작 (primary), 취소 (secondary)
 * Description varies by headingCount / documentTitle presence.
 */
function _buildOutlineDraftCardKo(
  headingCount: number | undefined,
  documentTitle: string | undefined,
): ConfirmationCard {
  const sectionPhrase =
    headingCount !== undefined ? `${headingCount}개 섹션` : '각 섹션';
  const docPhrase = documentTitle ? ` ("${documentTitle}")` : '';
  const description =
    `AI가${docPhrase} ${sectionPhrase}의 본문을 자동으로 작성합니다. ` +
    `각 섹션을 검토하고 수락 또는 거절할 수 있습니다.`;

  return {
    title: '아웃라인 작성 시작할까요?',
    description,
    actions: [
      { id: 'start', label: '시작', variant: 'primary' },
      { id: 'cancel', label: '취소', variant: 'secondary' },
    ],
  };
}
