/**
 * resolve-user-approval.ts
 *
 * Pure function that resolves a user's interaction with a ConfirmationCard into
 * an immutable WorkflowState for the Outline→Draft agentic workflow.
 *
 * The function bridges the user-approval UI layer (ConfirmationCard interaction)
 * with the workflow state management layer (WorkflowState discriminated union):
 *
 *   action === 'approve' → TriggerOutlineToDraftState
 *     The user confirmed they want to start the Outline→Draft workflow.
 *     A TriggerOutlineToDraftState is constructed from the confirmation card
 *     context, driving the Side Chat panel into `outline_draft` workflow_mode.
 *
 *   action === 'cancel'  → NoOpState
 *     The user cancelled the confirmation. The Side Chat panel remains in (or
 *     returns to) the default flat_qa mode — no structural workflow is active.
 *
 * PURITY:
 *   This function is deterministic with respect to the card and action inputs:
 *   - The 'cancel' branch always returns { type: 'noop' } — fully deterministic.
 *   - The 'approve' branch derives all fields from the ConfirmationCard argument
 *     and produces structurally identical outputs for identical card inputs.
 *     The only field that varies between calls with the same card is `triggeredAt`,
 *     which reflects the Unix millisecond timestamp at construction time.
 *     All other fields (`type`, `userMessage`, `confidence`, `signals`) are
 *     deterministically derived from `card` and produce equal outputs for equal
 *     inputs — satisfying the spirit of referential transparency for a function
 *     whose only side-effect-adjacent behaviour is reading the wall clock.
 *
 * ROLLBACK SAFETY:
 *   - Pure module: zero imports from UI, Electron, DOM, or editor code.
 *   - No side effects, no global state, no module-level initialisation.
 *   - Callers guard invocations behind the `outlineDraftEnabled` feature-toggle
 *     preference — this module has no awareness of that toggle.
 *   - Removing all callers fully reverts approval resolution to v1.0 behavior
 *     with no data migration or config change required.
 *   - v1.0 documents that never surface in Side Chat are completely unaffected.
 */

import type { ConfirmationCard } from './confirmation-card';
import {
  buildTriggerOutlineToDraftState,
  buildNoOpState,
  type WorkflowState,
} from './workflow-state';

// Re-export WorkflowState so callers that only import from this module can
// still type-narrow the returned union without a separate import.
export type { WorkflowState };

// ---------------------------------------------------------------------------
// resolveUserApproval
// ---------------------------------------------------------------------------

/**
 * Resolves a user's ConfirmationCard interaction into an immutable WorkflowState.
 *
 * When the user clicks the primary "Start" action (action === 'approve'), returns
 * a frozen `TriggerOutlineToDraftState` that drives the Side Chat panel into
 * `outline_draft` workflow_mode for the multi-step section-drafting UI.
 *
 * When the user clicks the secondary "Cancel" action (action === 'cancel'), returns
 * a frozen `NoOpState` representing the default flat_qa mode — no structural
 * workflow is active and the Side Chat panel behaves identically to v1.0.
 *
 * The returned state is always a frozen (`Object.isFrozen === true`) discriminated
 * union value; callers narrow with `state.type`.
 *
 * ROLLBACK SAFETY: Removing all callers of this function fully reverts the
 * Outline→Draft approval resolution with no data migration required.
 *
 * @param card   - The ConfirmationCard the user interacted with.  Used to derive
 *                 the `userMessage` field of the returned TriggerOutlineToDraftState
 *                 when action is 'approve'.  Ignored entirely for 'cancel'.
 * @param action - The user's decision:
 *                   'approve' — start the Outline→Draft workflow.
 *                   'cancel'  — dismiss and remain in flat_qa mode.
 * @returns An immutable `WorkflowState`:
 *          - 'approve' → frozen `TriggerOutlineToDraftState`
 *          - 'cancel'  → frozen `NoOpState`
 *
 * @example
 * const card = buildConfirmationCard({
 *   type: 'outline_draft',
 *   message: 'Please draft each section',
 *   confidence: 0.9,
 *   signals: ['exact_trigger'],
 * });
 *
 * // User clicks "Start"
 * const approveState = resolveUserApproval(card, 'approve');
 * // approveState.type === 'trigger_outline_to_draft'
 * // Object.isFrozen(approveState) === true
 *
 * // User clicks "Cancel"
 * const cancelState = resolveUserApproval(card, 'cancel');
 * // cancelState.type === 'noop'
 * // Object.isFrozen(cancelState) === true
 */
export function resolveUserApproval(
  card: ConfirmationCard,
  action: 'approve' | 'cancel',
): WorkflowState {
  // ── Cancel branch ──────────────────────────────────────────────────────────
  // Dismiss the confirmation card and return to flat_qa mode.
  // This branch is fully deterministic — the card argument is not used.
  if (action === 'cancel') {
    return buildNoOpState();
  }

  // ── Approve branch ─────────────────────────────────────────────────────────
  // The user has explicitly confirmed they want to start the Outline→Draft
  // workflow.  Build a TriggerOutlineToDraftState from the card context:
  //
  //   userMessage — derived from card.title, which summarises the confirmed
  //                 intent and is deterministically equal for equal card inputs.
  //   confidence  — 1.0: explicit user approval overrides AI confidence; the
  //                 user has seen the card and actively clicked "Start".
  //   signals     — ['user_approved']: a single signal indicating the user
  //                 took an explicit approval action via the confirmation card.
  //
  // `triggeredAt` is omitted and defaults to Date.now() inside the factory,
  // so it reflects the wall-clock time of the call.  All other fields are
  // deterministically derived from `card` — same card always yields the same
  // userMessage, confidence, and signals.
  return buildTriggerOutlineToDraftState({
    userMessage: card.title,
    confidence: 1.0,
    signals: ['user_approved'],
  });
}
