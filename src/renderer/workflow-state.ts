/**
 * workflow-state.ts
 *
 * Immutable workflow state constructors for the Outline→Draft agentic workflow.
 *
 * The Side Chat panel maintains one of two workflow states at any moment:
 *
 *   - `trigger_outline_to_draft` — user has confirmed the Outline→Draft workflow;
 *     the panel should switch to the multi-step drafting UI.
 *   - `noop`                     — no structural workflow is active; the panel
 *     operates in standard flat QA mode.
 *
 * Two factory functions are provided:
 *   - buildTriggerOutlineToDraftState(payload)
 *       Returns a frozen TriggerOutlineToDraftState suitable for driving the
 *       outline_draft workflow_mode in the Side Chat panel.
 *
 *   - buildNoOpState()
 *       Returns a frozen NoOpState representing the default flat_qa mode.
 *
 * Both constructors return `Object.freeze()`-d objects so that mutation
 * attempts throw a TypeError in strict mode (ESM modules are always strict)
 * or are silently ignored in non-strict mode. TypeScript `readonly` fields
 * reinforce this at compile time.
 *
 * The discriminated union `WorkflowState` enables callers to type-narrow with
 * a single `state.type` check — no instanceof required.
 *
 * ROLLBACK SAFETY:
 *   - Pure module: zero imports from UI, Electron, DOM, or editor code.
 *   - No side effects, no global state, no module-level initialisation.
 *   - Both factory functions are independently usable — callers can import
 *     only the one they need without pulling in the other.
 *   - Callers guard invocations behind the `outlineDraftEnabled` feature-toggle
 *     preference — this file has no awareness of that toggle.
 *   - Deleting all callers fully reverts workflow state management to v1.0
 *     (no WorkflowState concept) with no data migration required.
 *   - v1.0 documents that never surface in the Outline→Draft workflow are
 *     completely unaffected by this module.
 */

// ---------------------------------------------------------------------------
// TriggerOutlineToDraftState
// ---------------------------------------------------------------------------

/**
 * Workflow state emitted when the user confirms they want to start the
 * Outline→Draft workflow.
 *
 * This state drives the Side Chat panel into `outline_draft` workflow_mode:
 * it triggers the multi-step section-by-section drafting UI (split view,
 * accept/reject/regenerate controls, progress indicators).
 *
 * All fields are `readonly` — TypeScript enforces this at compile time.
 * The constructed object is also `Object.freeze()`-d for runtime immutability.
 *
 * Fields:
 *   `type`       — discriminant; always the string literal
 *                  `'trigger_outline_to_draft'`.
 *   `userMessage` — the raw Side Chat message that confirmed the workflow
 *                  (forwarded for context display or prompt assembly).
 *   `confidence`  — normalised [0, 1] intent-detection score; preserved for
 *                  transparency UI ("AI detected this with N% confidence").
 *   `signals`     — human-readable matched-pattern labels from intent detection
 *                  (e.g. `['exact_trigger', 'section_scope_en']`).
 *   `triggeredAt` — Unix timestamp (ms) when the state was constructed; used
 *                  for ordering, logging, and abort-restore comparisons.
 */
export interface TriggerOutlineToDraftState {
  readonly type: 'trigger_outline_to_draft';
  /** Raw Side Chat message that triggered the Outline→Draft workflow. */
  readonly userMessage: string;
  /** Intent-detection confidence score in [0, 1]. */
  readonly confidence: number;
  /** Human-readable intent-signal labels from the detection layer. */
  readonly signals: readonly string[];
  /** Unix timestamp (ms) when the state was constructed via the factory. */
  readonly triggeredAt: number;
}

// ---------------------------------------------------------------------------
// NoOpState
// ---------------------------------------------------------------------------

/**
 * Workflow state representing the default flat QA mode — no Outline→Draft
 * workflow is active.
 *
 * In this state the Side Chat panel operates identically to v1.0: a simple
 * single-turn AI streaming Q&A interface with no structural UI overlays.
 *
 * All fields are `readonly` and the constructed object is `Object.freeze()`-d.
 *
 * Fields:
 *   `type` — discriminant; always the string literal `'noop'`.
 */
export interface NoOpState {
  readonly type: 'noop';
}

// ---------------------------------------------------------------------------
// WorkflowState discriminated union
// ---------------------------------------------------------------------------

/**
 * Discriminated union of all possible Side Chat workflow states.
 *
 * Callers narrow the union with a type guard on `state.type`:
 *
 * @example
 * function handleState(state: WorkflowState) {
 *   switch (state.type) {
 *     case 'trigger_outline_to_draft':
 *       startDraftingWorkflow(state.userMessage, state.signals);
 *       break;
 *     case 'noop':
 *       // nothing to do — remain in flat QA mode
 *       break;
 *   }
 * }
 */
export type WorkflowState = TriggerOutlineToDraftState | NoOpState;

// ---------------------------------------------------------------------------
// TriggerOutlineToDraftPayload — input type for buildTriggerOutlineToDraftState
// ---------------------------------------------------------------------------

/**
 * Input payload for `buildTriggerOutlineToDraftState`.
 *
 * All fields map directly to the correspondingly-named fields on the
 * constructed `TriggerOutlineToDraftState`.  `triggeredAt` is optional — when
 * omitted the factory uses `Date.now()` so callers do not need to supply a
 * timestamp themselves.
 *
 * `userMessage`  — required; raw Side Chat message confirming the workflow.
 * `confidence`   — required; intent-detection score in [0, 1].
 * `signals`      — required; pattern-group labels from the detection layer.
 * `triggeredAt`  — optional; Unix timestamp (ms). Defaults to `Date.now()`.
 */
export interface TriggerOutlineToDraftPayload {
  /** Raw Side Chat message that confirmed the workflow. */
  userMessage: string;
  /** Intent-detection confidence in [0, 1]. */
  confidence: number;
  /** Human-readable intent-signal labels. */
  signals: string[];
  /** Optional Unix timestamp (ms). Defaults to Date.now() when omitted. */
  triggeredAt?: number;
}

// ---------------------------------------------------------------------------
// buildTriggerOutlineToDraftState
// ---------------------------------------------------------------------------

/**
 * Constructs an immutable `TriggerOutlineToDraftState` from a payload object.
 *
 * The returned object:
 *  - Has `type === 'trigger_outline_to_draft'` (discriminant).
 *  - Carries all payload fields verbatim (no transformation or validation).
 *  - Uses `Date.now()` for `triggeredAt` when the payload omits the field.
 *  - Is `Object.freeze()`-d — any mutation attempt throws a `TypeError` in
 *    strict mode (ESM) or is silently ignored in non-strict mode.
 *  - Has a frozen `signals` array — the array reference cannot be replaced
 *    and its elements cannot be mutated via the state object.
 *
 * ROLLBACK SAFETY: Removing all callers of this function fully reverts the
 * Outline→Draft workflow trigger with no data migration required.
 *
 * @param payload - Required fields for the state; `triggeredAt` is optional.
 * @returns A frozen `TriggerOutlineToDraftState`.
 *
 * @example
 * const state = buildTriggerOutlineToDraftState({
 *   userMessage: 'Please draft each section',
 *   confidence: 0.9,
 *   signals: ['exact_trigger'],
 * });
 * // state.type         === 'trigger_outline_to_draft'
 * // state.userMessage  === 'Please draft each section'
 * // state.confidence   === 0.9
 * // state.signals      deep-equals ['exact_trigger']
 * // state.triggeredAt  is a number (Date.now() at construction time)
 * // Object.isFrozen(state)  === true
 */
export function buildTriggerOutlineToDraftState(
  payload: TriggerOutlineToDraftPayload,
): TriggerOutlineToDraftState {
  // Freeze the signals array independently so its elements are also immutable
  // via the state reference (shallow freeze of the outer object would still
  // allow array-element mutations without this step).
  const frozenSignals = Object.freeze([...payload.signals]);

  return Object.freeze<TriggerOutlineToDraftState>({
    type: 'trigger_outline_to_draft',
    userMessage: payload.userMessage,
    confidence: payload.confidence,
    signals: frozenSignals,
    triggeredAt: payload.triggeredAt ?? Date.now(),
  });
}

// ---------------------------------------------------------------------------
// buildNoOpState
// ---------------------------------------------------------------------------

/**
 * Constructs an immutable `NoOpState` representing the default flat QA mode.
 *
 * The returned object:
 *  - Has `type === 'noop'` (discriminant).
 *  - Has no additional payload fields.
 *  - Is `Object.freeze()`-d — any mutation attempt throws a `TypeError` in
 *    strict mode (ESM) or is silently ignored in non-strict mode.
 *
 * Callers can use this to reset the Side Chat panel to the v1.0-equivalent
 * flat QA mode after a workflow completes, is cancelled, or is aborted.
 *
 * ROLLBACK SAFETY: Removing all callers of this function fully reverts the
 * workflow state concept with no data migration required.
 *
 * @returns A frozen `NoOpState`.
 *
 * @example
 * const state = buildNoOpState();
 * // state.type           === 'noop'
 * // Object.isFrozen(state) === true
 */
export function buildNoOpState(): NoOpState {
  return Object.freeze<NoOpState>({
    type: 'noop',
  });
}
