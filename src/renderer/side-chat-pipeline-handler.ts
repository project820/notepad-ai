/**
 * side-chat-pipeline-handler.ts
 *
 * Middleware that routes a raw Side Chat user message through the full
 * message pipeline:
 *
 *   1. Intent detection  — detectOutlineDraftIntent(message)
 *   2. Event construction — buildConfirmationCardEvent or buildNormalResponseEvent
 *   3. Event emission    — emitter(event)
 *
 * This module is the single integration point for Sub-AC 6c-ii.  It receives
 * a user message string plus an emitter callback, runs intent detection, and
 * calls exactly one of the two event constructors — then emits the result.
 *
 * Routing rules:
 *   isOutlineDraft === true  → buildConfirmationCardEvent → emitter
 *   isOutlineDraft === false → buildNormalResponseEvent   → emitter
 *
 * The emitter is called exactly once per invocation.  Callers that receive a
 * `confirmation_card` event must render the ConfirmationCard UI; callers that
 * receive a `normal_response` event route the message to the standard AI call.
 *
 * ROLLBACK SAFETY:
 *   - Pure function: no imports from UI, Electron, DOM, or window globals.
 *   - No global state, no module-level initialisation, no side effects.
 *   - Callers guard invocations behind the `outlineDraftEnabled` feature-toggle
 *     preference — this module has no awareness of that toggle.
 *   - Removing all callers of this function fully reverts the pipeline routing
 *     to v1.0 behavior with no data migration or config change required.
 *   - v1.0 documents that never surface in Side Chat are unaffected.
 */

import { detectOutlineDraftIntent } from './outline-draft-intent';
import {
  buildConfirmationCardEvent,
  buildNormalResponseEvent,
  type ChatPipelineEvent,
  type ConfirmationCardIntentResult,
} from './chat-pipeline-events';

// ---------------------------------------------------------------------------
// PipelineEmitter type
// ---------------------------------------------------------------------------

/**
 * Callback signature for the event emitter passed to
 * `sideChatMessagePipelineHandler`.
 *
 * The emitter is called exactly once per handler invocation.  It receives a
 * fully-constructed `ChatPipelineEvent` discriminated union — either a
 * `ConfirmationCardEvent` or a `NormalResponseEvent`.
 *
 * Callers narrow the received event with `event.type`:
 *
 * @example
 * const emitter: PipelineEmitter = (event) => {
 *   if (event.type === 'confirmation_card') {
 *     renderConfirmationCard(event.card);
 *   } else {
 *     streamAiResponse(event.message);
 *   }
 * };
 */
export type PipelineEmitter = (event: ChatPipelineEvent) => void;

// ---------------------------------------------------------------------------
// sideChatMessagePipelineHandler
// ---------------------------------------------------------------------------

/**
 * Side Chat message pipeline middleware.
 *
 * Accepts a raw user message string and a `PipelineEmitter` callback.
 * Runs the message through `detectOutlineDraftIntent`, selects the
 * appropriate event constructor, and emits the result to the caller.
 *
 * The emitter is guaranteed to be called **exactly once** per invocation,
 * with either a `ConfirmationCardEvent` or a `NormalResponseEvent`.
 *
 * Routing table:
 * | Intent result          | Event type              | Constructor called            |
 * |------------------------|-------------------------|-------------------------------|
 * | isOutlineDraft = true  | 'confirmation_card'     | buildConfirmationCardEvent()  |
 * | isOutlineDraft = false | 'normal_response'       | buildNormalResponseEvent()    |
 *
 * Optional context fields (`headingCount`, `documentTitle`, `language`) are not
 * accepted by this function — callers that need them should build the
 * `ConfirmationCardIntentResult` directly and call `buildConfirmationCardEvent`
 * themselves rather than passing through this middleware.
 *
 * @param message - Raw user message text from the Side Chat input field.
 *   An empty string or whitespace-only string is accepted; intent detection
 *   will classify it as non-structural and a `NormalResponseEvent` is emitted.
 * @param emitter - Callback that receives the constructed `ChatPipelineEvent`.
 *   Called exactly once.  Must not throw (errors in the emitter are the
 *   caller's responsibility).
 * @returns void — the pipeline result is delivered asynchronously via emitter.
 *
 * @example
 * // Structural intent — emitter receives ConfirmationCardEvent
 * sideChatMessagePipelineHandler(
 *   'Please draft each section',
 *   (event) => {
 *     // event.type === 'confirmation_card'
 *     renderCard(event.card);
 *   },
 * );
 *
 * @example
 * // Normal intent — emitter receives NormalResponseEvent
 * sideChatMessagePipelineHandler(
 *   'What do you think about the structure?',
 *   (event) => {
 *     // event.type === 'normal_response'
 *     streamAiResponse(event.message);
 *   },
 * );
 */
export function sideChatMessagePipelineHandler(
  message: string,
  emitter: PipelineEmitter,
): void {
  // ── Step 1: Intent detection ──────────────────────────────────────────────
  const intentResult = detectOutlineDraftIntent(message);

  // ── Step 2: Route to appropriate event constructor ────────────────────────
  if (intentResult.isOutlineDraft) {
    // Structural branch — user wants to start the Outline→Draft workflow.
    // Build a ConfirmationCardEvent so the Side Chat UI can display the
    // intent_card confirmation element before mutating the document.
    const extendedResult: ConfirmationCardIntentResult = {
      ...intentResult,
      userMessage: message,
      // headingCount / documentTitle / language are not available at this
      // middleware level — callers with document-state access should bypass
      // this function and call buildConfirmationCardEvent directly.
    };
    emitter(buildConfirmationCardEvent(extendedResult));
  } else {
    // Normal branch — standard Side Chat AI response.
    // Route the raw message to the single-turn AI streaming call.
    emitter(buildNormalResponseEvent(message));
  }
}
