/**
 * settings-editor-panel.ts — SettingsEditorPanel UI component.
 *
 * Phase 1 of notepad-ai v1.1 "Prompt Stack Foundation".
 *
 * Provides a labelled textarea editor pre-populated with file content and
 * Save / Cancel action buttons.  Used by the settings UI to let users edit
 * `systemlaw.md` and `Owner.md` stored in userData.
 *
 * ─── Design ──────────────────────────────────────────────────────────────────
 *
 * Two exported entry points deliberately separate concerns:
 *
 *   `renderSettingsEditorPanel(opts)` — pure function, no DOM access.
 *     Returns the HTML markup string for the panel.  Used by the mount
 *     function below and directly testable in a Node environment without a
 *     real DOM.
 *
 *   `mountSettingsEditorPanel(parent, opts)` — DOM-dependent.
 *     Injects the HTML into `parent`, wires up Save / Cancel event listeners,
 *     and returns a handle for programmatic access.
 *
 * ─── Korean IME guard ────────────────────────────────────────────────────────
 *
 * Any keyboard handler that submits on Enter must include the composition
 * guard per HANDOFF.md rule #4:
 *   `if (e.isComposing || e.keyCode === 229) return;`
 *
 * ─── Graceful fallback ───────────────────────────────────────────────────────
 *
 * Both functions never throw: empty / undefined `initialContent` is normalised
 * to `''`.  The render function escapes HTML entities so arbitrary file content
 * is injected safely.
 *
 * ─── CSS classes (sep-*) ─────────────────────────────────────────────────────
 *
 * All class names are prefixed `sep-` (Settings Editor Panel) to avoid
 * collisions.  Tokens from design-tokens.css (--color-*, --r-*, --sp-*,
 * --type-*) are referenced in styles.css.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Options for rendering the settings editor panel.
 *
 * Both fields have safe defaults so callers can omit `initialContent` when
 * the userData file does not exist yet.
 */
export type SettingsEditorPanelRenderOptions = {
  /** Human-readable label shown above the textarea (e.g. "System Law"). */
  label: string;
  /**
   * Pre-loaded file content to populate the textarea.
   * Pass `''` (or omit) when the file does not exist — textarea will be empty.
   */
  initialContent?: string;
};

/**
 * Options for mounting the interactive settings editor panel.
 * Extends render options with callback hooks.
 */
export type SettingsEditorPanelOptions = SettingsEditorPanelRenderOptions & {
  /**
   * Called when the user clicks Save.
   * Receives the current textarea value (may differ from `initialContent`
   * if the user edited it).
   */
  onSave: (content: string) => void;
  /** Called when the user clicks Cancel with no side-effects. */
  onCancel: () => void;
};

/**
 * Handle returned by `mountSettingsEditorPanel`.
 * Provides imperative access to the mounted panel state.
 */
export type SettingsEditorPanelHandle = {
  /** Returns the current textarea value (live, reflects user edits). */
  getContent: () => string;
  /** Removes the panel HTML from the parent and tears down event listeners. */
  destroy: () => void;
};

// ---------------------------------------------------------------------------
// HTML escape helper
// ---------------------------------------------------------------------------

/**
 * Escapes the five HTML special characters so file content can be safely
 * injected into a `<textarea>` value attribute or inner text.
 *
 * Notably, `<textarea>` content is text (not HTML), so only `&` and `<` are
 * strictly required — we escape all five for defence-in-depth.
 */
function escapeHTML(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ---------------------------------------------------------------------------
// Pure render function (testable in Node, no DOM required)
// ---------------------------------------------------------------------------

/**
 * Returns the HTML markup string for the settings editor panel.
 *
 * Pure function — reads nothing, writes nothing, touches no globals.
 * Safe to call in any environment (Node test runner included).
 *
 * @param opts - Label and optional initial content.
 * @returns    HTML string ready to be assigned to `element.innerHTML`.
 */
export function renderSettingsEditorPanel(
  opts: SettingsEditorPanelRenderOptions,
): string {
  const label = opts.label ?? '';
  const content = opts.initialContent ?? '';

  return `<div class="sep-root">
  <label class="sep-label" for="sep-textarea">${escapeHTML(label)}</label>
  <textarea
    class="sep-textarea"
    id="sep-textarea"
    rows="20"
    spellcheck="false"
    aria-label="${escapeHTML(label)}"
  >${escapeHTML(content)}</textarea>
  <div class="sep-actions">
    <button class="sep-btn sep-btn-cancel" data-sep-action="cancel" type="button">Cancel</button>
    <button class="sep-btn sep-btn-save" data-sep-action="save" type="button">Save</button>
  </div>
</div>`;
}

// ---------------------------------------------------------------------------
// DOM-dependent mount function
// ---------------------------------------------------------------------------

/**
 * Mounts the settings editor panel into `parent`.
 *
 * Injects HTML via `renderSettingsEditorPanel`, then wires Save / Cancel
 * click handlers.  The `parent`'s existing content is replaced.
 *
 * Korean IME guard is applied to the textarea's keydown handler so that
 * composition events (e.g. from Korean input) do not trigger unintended
 * submit behaviour if the caller extends this with keyboard shortcuts.
 *
 * @param parent - Container element to mount the panel into.
 * @param opts   - Render options plus Save / Cancel callbacks.
 * @returns      Handle providing `getContent()` and `destroy()`.
 */
export function mountSettingsEditorPanel(
  parent: HTMLElement,
  opts: SettingsEditorPanelOptions,
): SettingsEditorPanelHandle {
  // Inject HTML.
  parent.innerHTML = renderSettingsEditorPanel(opts);

  // Resolve interactive elements.
  const textarea = parent.querySelector<HTMLTextAreaElement>('.sep-textarea');
  const saveBtn  = parent.querySelector<HTMLButtonElement>('[data-sep-action="save"]');
  const cancelBtn = parent.querySelector<HTMLButtonElement>('[data-sep-action="cancel"]');

  // Graceful fallback: if somehow querySelector returns null (malformed DOM),
  // attach handlers only when elements exist — never crash.
  if (saveBtn) {
    saveBtn.addEventListener('click', () => {
      const value = textarea?.value ?? '';
      opts.onSave(value);
    });
  }

  if (cancelBtn) {
    cancelBtn.addEventListener('click', () => {
      opts.onCancel();
    });
  }

  // Korean IME guard on the textarea (HANDOFF.md rule #4).
  // Currently a no-op unless callers add keyboard shortcuts — kept here so
  // future Ctrl+Enter "submit" shortcuts automatically get the guard.
  if (textarea) {
    textarea.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.isComposing || e.keyCode === 229) return;
      // Future shortcut handlers (e.g. Ctrl+S to save) go here.
    });
  }

  return {
    getContent: () => textarea?.value ?? '',
    destroy: () => {
      parent.innerHTML = '';
    },
  };
}
