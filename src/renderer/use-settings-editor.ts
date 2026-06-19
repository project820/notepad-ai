/**
 * use-settings-editor.ts — Stateful draft editor hook for the Settings UI.
 *
 * Phase 1 of notepad-ai v1.1 "Prompt Stack Foundation".
 *
 * Provides a lightweight state-management factory (`useSettingsEditor`) for
 * the settings editor panels that let users edit `systemlaw.md` and `Owner.md`
 * stored in userData.
 *
 * ─── Design ──────────────────────────────────────────────────────────────────
 *
 * This is a vanilla-TypeScript "hook" (factory function) — NOT a React hook.
 * It follows the same pattern as the toggle module: plain in-memory state, no
 * global side-effects, trivially testable without DOM or Electron stubs.
 *
 * Returned object contract:
 *
 *   `draft`       — current draft string; starts equal to `currentContent`.
 *   `setDraft(v)` — updates the draft in place (user is editing).
 *   `isDirty()`   — returns true if draft differs from the original content.
 *   `reset()`     — reverts draft to the original `currentContent`.
 *   `commit()`    — returns the final draft value (for passing to onSave).
 *
 * ─── Graceful fallback ───────────────────────────────────────────────────────
 *
 * `currentContent` is normalised to `''` when it is `undefined` or `null` so
 * callers can safely pass the result of a file-read that may return no content.
 * Never throws.
 *
 * ─── Usage ───────────────────────────────────────────────────────────────────
 *
 * ```ts
 * import { useSettingsEditor } from './use-settings-editor';
 *
 * // Initialise with the file's current content (or '' if file is absent).
 * const editor = useSettingsEditor(fileContent ?? '');
 *
 * // Bind to a textarea's input event.
 * textarea.addEventListener('input', () => editor.setDraft(textarea.value));
 *
 * // On Save button click:
 * saveBtn.addEventListener('click', () => onSave(editor.commit()));
 *
 * // On Cancel button click (discard changes):
 * cancelBtn.addEventListener('click', () => editor.reset());
 * ```
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * State object returned by `useSettingsEditor`.
 *
 * All methods are synchronous and never throw.
 */
export type SettingsEditorHook = {
  /**
   * The current draft value.
   *
   * On construction this is exactly equal to the `currentContent` argument
   * passed to `useSettingsEditor`.  It changes as the user edits via
   * `setDraft`.
   */
  readonly draft: string;

  /**
   * Updates the draft to `value`.
   *
   * Called on every keystroke / `input` event from the textarea.
   * Normalises `undefined`/`null` to `''` — never throws.
   *
   * @param value - The new draft string.
   */
  setDraft(value: string): void;

  /**
   * Returns `true` when the current draft differs from the `currentContent`
   * that was passed to `useSettingsEditor`.
   *
   * Useful for enabling / disabling the Save button.
   */
  isDirty(): boolean;

  /**
   * Resets the draft back to the original `currentContent`.
   *
   * Called when the user clicks Cancel.  After this call `isDirty()` returns
   * `false` and `draft` equals the original content again.
   */
  reset(): void;

  /**
   * Returns the current draft value — identical to reading `.draft`.
   *
   * Provided as a method so callers can pass it as a callback reference
   * without needing to close over the state object.
   *
   * @returns The current draft string.
   */
  commit(): string;

  /**
   * Cancels the current edit session by resetting the draft back to the
   * original `currentContent` that was passed to `useSettingsEditor`.
   *
   * After this call:
   *   - `draft` equals the original construction-time content.
   *   - `isDirty()` returns `false`.
   *
   * This is the canonical action for a "Cancel" button in the settings UI.
   * Equivalent to `reset()` but named to match the UI affordance and satisfy
   * Sub-AC 5.2c.  Never throws, never performs any I/O.
   */
  cancel(): void;
};

// ---------------------------------------------------------------------------
// Factory function
// ---------------------------------------------------------------------------

/**
 * Creates a stateful draft editor state for a settings panel.
 *
 * The returned `SettingsEditorHook` object holds the draft state in closure.
 * Access `hook.draft` to read the current draft, call `hook.setDraft(v)` to
 * update it.
 *
 * On construction, `hook.draft` is **exactly equal** to `currentContent`
 * (or `''` if `currentContent` is nullish).
 *
 * Never throws.
 *
 * @param currentContent - The file's current content to pre-populate the
 *   draft.  Pass `''` (or omit) when the file does not exist yet.
 * @returns A `SettingsEditorHook` managing the mutable draft state.
 *
 * @example
 * const hook = useSettingsEditor('# System Law\n\nBe concise.');
 * console.log(hook.draft); // '# System Law\n\nBe concise.'
 * hook.setDraft('Updated content');
 * console.log(hook.draft); // 'Updated content'
 * console.log(hook.isDirty()); // true
 * hook.reset();
 * console.log(hook.draft); // '# System Law\n\nBe concise.'
 */
export function useSettingsEditor(currentContent: string): SettingsEditorHook {
  // Normalise: treat null/undefined as empty string — never crash.
  const original: string = currentContent ?? '';

  // Mutable draft state held in closure — no class, no global.
  let _draft: string = original;

  return {
    get draft(): string {
      return _draft;
    },

    setDraft(value: string): void {
      // Normalise input — same graceful-fallback rule.
      _draft = value ?? '';
    },

    isDirty(): boolean {
      return _draft !== original;
    },

    reset(): void {
      _draft = original;
    },

    commit(): string {
      return _draft;
    },

    cancel(): void {
      // Identical to reset(): discard edits, revert to construction-time content.
      // Provided as a distinct method so the settings UI can bind Cancel buttons
      // to a clearly named action without aliasing through `reset`.
      _draft = original;
    },
  };
}
