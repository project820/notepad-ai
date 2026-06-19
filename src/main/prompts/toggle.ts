/**
 * toggle.ts — Feature toggle for the v1.1 prompt-stack assembly pipeline.
 *
 * Phase 1 of notepad-ai v1.1 "Prompt Stack Foundation".
 *
 * Exposes a single boolean gate that controls whether the new 7-layer prompt
 * assembly path (systemlaw / Owner / ordered layers) is used by the four AI
 * surfaces (Block AI, Side Chat, Bottom Chat, Quality Dial).
 *
 * ─── Default: OFF ────────────────────────────────────────────────────────────
 *
 * The toggle defaults to `false` (off).  When off, every AI surface falls back
 * to the v1.0 ad-hoc prompt strings — byte-identical to the pre-v1.1 behaviour.
 * The new assembly code paths are never entered, so the v1.0 UX is perfectly
 * preserved for users who have not opted in.
 *
 * ─── Design ──────────────────────────────────────────────────────────────────
 *
 * This module intentionally holds **only in-memory state**.  Persistence to
 * userData is handled one layer up (main.ts IPC handlers read/write a dedicated
 * prefs file and call `setPromptAssemblyEnabled` on startup and on user action).
 * Keeping persistence out of this module makes it trivially testable — no
 * filesystem stubs required.
 *
 * ─── Rollback safety ─────────────────────────────────────────────────────────
 *
 * Because the default is `false`, a cold start (no persisted toggle state) is
 * indistinguishable from v1.0.  The flag must be explicitly set to `true` (opt-in)
 * for any new behaviour to activate.
 *
 * ─── Usage ───────────────────────────────────────────────────────────────────
 *
 * ```ts
 * // Checking the toggle at an AI surface call-site
 * import { isPromptAssemblyEnabled } from './prompts/toggle';
 *
 * if (isPromptAssemblyEnabled()) {
 *   systemPrompt = assemblePrompt(request);
 * } else {
 *   systemPrompt = legacySystemPrompt(); // v1.0 path
 * }
 *
 * // Enabling from a settings IPC handler
 * import { setPromptAssemblyEnabled } from './prompts/toggle';
 * ipcMain.handle('toggle:prompt-assembly', (_ev, enabled: boolean) => {
 *   setPromptAssemblyEnabled(enabled);
 * });
 *
 * // Test isolation — reset after each test
 * import { resetPromptAssembly } from './prompts/toggle';
 * afterEach(() => resetPromptAssembly());
 * ```
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * The default value of the prompt-assembly feature toggle.
 *
 * Always `false` — the toggle is **off by default** so that v1.0 behaviour is
 * preserved until the user (or a settings migration) explicitly opts in.
 *
 * Exported so tests and callers can compare against it without hard-coding
 * the literal `false`.
 */
export const PROMPT_ASSEMBLY_DEFAULT = false as const;

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

/**
 * Internal toggle state.  Shared across all callers in the same process.
 * Starts as `PROMPT_ASSEMBLY_DEFAULT` (false).
 *
 * `let` (not `const`) — this is the single mutable piece of state in the
 * module.  All mutations are guarded through `setPromptAssemblyEnabled`.
 */
let _enabled: boolean = PROMPT_ASSEMBLY_DEFAULT;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns `true` when the v1.1 prompt-stack assembly feature is currently
 * enabled; `false` otherwise.
 *
 * This is the primary gate used by every AI surface before calling
 * `assemblePrompt`.  When it returns `false`, the surface must use its
 * existing v1.0 ad-hoc prompt string unchanged.
 *
 * Never throws.  Return type is always `boolean`.
 *
 * @returns The current enabled state of the prompt-assembly feature.
 *
 * @example
 * if (isPromptAssemblyEnabled()) {
 *   // new 7-layer assembly path
 * } else {
 *   // legacy v1.0 prompt path
 * }
 */
export function isPromptAssemblyEnabled(): boolean {
  return _enabled;
}

/**
 * Sets the enabled state of the v1.1 prompt-stack assembly feature.
 *
 * Call with `true` to activate the new 7-layer prompt pipeline.
 * Call with `false` to return to the v1.0 ad-hoc prompt strings.
 *
 * This function is **synchronous** and takes effect immediately — the next
 * call to `isPromptAssemblyEnabled()` will reflect the new value.
 *
 * In production, this is called:
 *   - On app startup: from the main-process prefs loader that reads the
 *     persisted toggle state from userData.
 *   - On user action: from the settings-page IPC handler when the user
 *     flips the toggle in the Settings UI.
 *
 * Never throws.
 *
 * @param enabled - `true` to enable the new assembly pipeline; `false` to disable.
 *
 * @example
 * // Enable the feature
 * setPromptAssemblyEnabled(true);
 *
 * // Disable the feature (restore v1.0 behaviour)
 * setPromptAssemblyEnabled(false);
 */
export function setPromptAssemblyEnabled(enabled: boolean): void {
  _enabled = enabled;
}

/**
 * Resets the toggle to its default state (`PROMPT_ASSEMBLY_DEFAULT` = `false`).
 *
 * This function exists **for test isolation only**.  Call it in `afterEach`
 * or `beforeEach` blocks to prevent one test from affecting the next.
 *
 * Production code MUST NOT call this function — the toggle state should only
 * be managed by `setPromptAssemblyEnabled` in response to explicit user or
 * startup actions.
 *
 * @example
 * import { resetPromptAssembly } from './prompts/toggle';
 * afterEach(() => resetPromptAssembly());
 */
export function resetPromptAssembly(): void {
  _enabled = PROMPT_ASSEMBLY_DEFAULT;
}
