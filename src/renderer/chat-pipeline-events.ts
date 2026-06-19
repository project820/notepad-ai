/**
 * chat-pipeline-events.ts
 *
 * Typed event payloads for the Side Chat message pipeline.
 *
 * The Side Chat processes each user message through the following pipeline:
 *   1. Intent detection  — detectOutlineDraftIntent() in outline-draft-intent.ts
 *   2. Event construction — THIS module (two constructors)
 *   3. Event dispatch     — rendered in Side Chat UI layer
 *
 * Two constructors are provided:
 *   - buildConfirmationCardEvent(intentResult)
 *       Routes to the Outline→Draft confirmation UI (intent_card in ontology).
 *       Wraps a fully-built ConfirmationCard plus detection metadata.
 *
 *   - buildNormalResponseEvent(message)
 *       Routes to the standard single-turn AI streaming response.
 *       Wraps a plain message string with a typed discriminant.
 *
 * The discriminated union `ChatPipelineEvent` enables callers to type-narrow
 * with a single `event.type` check — no instanceof needed.
 *
 * ROLLBACK SAFETY:
 *   - Pure module: zero imports from UI, Electron, DOM, or editor code.
 *   - No side effects, no global state, no module-level initialisation.
 *   - Callers guard invocations behind the `outlineDraftEnabled`
 *     feature-toggle preference — this file has no awareness of that toggle.
 *   - Deleting all callers fully reverts pipeline event behaviour with no
 *     data migration required.
 *   - v1.0 documents that never trigger intent detection are never affected.
 */

import type { ConfirmationCard } from './confirmation-card';
import { buildConfirmationCard } from './confirmation-card';
import type { IntentContext } from './confirmation-card';
import type { OutlineDraftIntentResult } from './outline-draft-intent';

// ---------------------------------------------------------------------------
// ConfirmationCardEvent
// ---------------------------------------------------------------------------

/**
 * Chat pipeline event emitted when intent detection identifies an
 * Outline→Draft request from the user's Side Chat message.
 *
 * The embedded `card` is fully populated and ready to render in the
 * Side Chat panel as an intent_card confirmation UI element.
 *
 * `type`       — discriminant; always the string literal `'confirmation_card'`.
 * `card`       — fully populated ConfirmationCard (title, description, actions).
 * `confidence` — normalised [0, 1] score from intent detection.
 * `signals`    — human-readable matched-pattern labels (transparency UI).
 */
export interface ConfirmationCardEvent {
  type: 'confirmation_card';
  card: ConfirmationCard;
  confidence: number;
  signals: string[];
}

// ---------------------------------------------------------------------------
// NormalResponseEvent
// ---------------------------------------------------------------------------

/**
 * Chat pipeline event emitted when a Side Chat message should be routed to
 * the standard single-turn AI streaming response — i.e. no Outline→Draft
 * intent was detected, or the user is in flat_qa workflow mode.
 *
 * `type`    — discriminant; always the string literal `'normal_response'`.
 * `message` — the raw user message text to forward to the AI call.
 */
export interface NormalResponseEvent {
  type: 'normal_response';
  message: string;
}

// ---------------------------------------------------------------------------
// ChatPipelineEvent discriminated union
// ---------------------------------------------------------------------------

/**
 * Discriminated union of all possible Side Chat pipeline event types.
 *
 * Callers narrow the union with a type guard on `event.type`:
 *
 * @example
 * function handleEvent(event: ChatPipelineEvent) {
 *   switch (event.type) {
 *     case 'confirmation_card':
 *       renderConfirmationCard(event.card);
 *       break;
 *     case 'normal_response':
 *       streamAiResponse(event.message);
 *       break;
 *   }
 * }
 */
export type ChatPipelineEvent = ConfirmationCardEvent | NormalResponseEvent;

// ---------------------------------------------------------------------------
// ConfirmationCardIntentResult — input type for buildConfirmationCardEvent
// ---------------------------------------------------------------------------

/**
 * Extended intent result carrying both detection metadata and the document
 * context needed to build a fully populated `ConfirmationCard`.
 *
 * Extends `OutlineDraftIntentResult` (fields: `isOutlineDraft`, `confidence`,
 * `signals`) with optional document-state fields and the original user message.
 *
 * `userMessage`   — raw Side Chat message that triggered intent detection;
 *                   forwarded to `IntentContext.message` for card building.
 * `headingCount`  — optional number of headings in the current document;
 *                   used to phrase "your N sections" in the card description.
 * `documentTitle` — optional file/document name quoted in the description.
 * `language`      — UI language ('en' | 'ko'); defaults to 'en' when absent.
 *
 * The optional fields are intentionally optional so callers can pass a
 * minimal object (just detection result + userMessage) without crashes.
 */
export interface ConfirmationCardIntentResult extends OutlineDraftIntentResult {
  /** Raw user message that triggered the intent detection. */
  userMessage: string;
  /** Number of headings in the current document (optional). */
  headingCount?: number;
  /** File/document name to quote in the card description (optional). */
  documentTitle?: string;
  /** UI language for the card copy; defaults to 'en'. */
  language?: 'en' | 'ko';
}

// ---------------------------------------------------------------------------
// buildConfirmationCardEvent
// ---------------------------------------------------------------------------

/**
 * Constructs a `ConfirmationCardEvent` from an extended intent result.
 *
 * Maps the intent result fields to an `IntentContext`, delegates to
 * `buildConfirmationCard` for card population, then wraps the card plus
 * detection metadata in a typed event with `type: 'confirmation_card'`.
 *
 * The constructed event satisfies `ChatPipelineEvent` and can be narrowed
 * by `event.type === 'confirmation_card'` in consuming code.
 *
 * @param intentResult - Extended intent result from the detection layer.
 *   Must have `isOutlineDraft`, `confidence`, `signals`, and `userMessage`.
 *   Optional: `headingCount`, `documentTitle`, `language`.
 * @returns A `ConfirmationCardEvent` ready to dispatch in the Side Chat pipeline.
 *
 * @example
 * const event = buildConfirmationCardEvent({
 *   isOutlineDraft: true,
 *   confidence: 0.9,
 *   signals: ['exact_trigger'],
 *   userMessage: 'Please draft each section',
 *   headingCount: 5,
 *   language: 'en',
 * });
 * // → {
 * //     type: 'confirmation_card',
 * //     card: {
 * //       title: 'Start Outline→Draft?',
 * //       description: 'AI will write body content for your 5 sections...',
 * //       actions: [{ id: 'start', ... }, { id: 'cancel', ... }],
 * //     },
 * //     confidence: 0.9,
 * //     signals: ['exact_trigger'],
 * //   }
 */
export function buildConfirmationCardEvent(
  intentResult: ConfirmationCardIntentResult,
): ConfirmationCardEvent {
  const intentContext: IntentContext = {
    type: 'outline_draft',
    message: intentResult.userMessage,
    confidence: intentResult.confidence,
    signals: intentResult.signals,
    headingCount: intentResult.headingCount,
    documentTitle: intentResult.documentTitle,
    language: intentResult.language,
  };

  const card = buildConfirmationCard(intentContext);

  return {
    type: 'confirmation_card',
    card,
    confidence: intentResult.confidence,
    signals: intentResult.signals,
  };
}

// ---------------------------------------------------------------------------
// buildNormalResponseEvent
// ---------------------------------------------------------------------------

/**
 * Constructs a `NormalResponseEvent` wrapping a message string.
 *
 * In the Side Chat pipeline, a `NormalResponseEvent` routes the user's
 * message to the standard single-turn AI streaming call rather than to
 * the Outline→Draft confirmation UI.
 *
 * The constructed event satisfies `ChatPipelineEvent` and can be narrowed
 * by `event.type === 'normal_response'` in consuming code.
 *
 * @param message - The user message text to route to the AI call.
 *   Must be a string; an empty string is accepted (callers should guard
 *   against sending empty messages before reaching this constructor).
 * @returns A `NormalResponseEvent` ready to dispatch in the Side Chat pipeline.
 *
 * @example
 * const event = buildNormalResponseEvent('What do you think about the structure?');
 * // → { type: 'normal_response', message: 'What do you think about the structure?' }
 */
export function buildNormalResponseEvent(message: string): NormalResponseEvent {
  return {
    type: 'normal_response',
    message,
  };
}
