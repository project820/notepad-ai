/**
 * use-settings-editor.test.ts
 *
 * Unit tests for the `useSettingsEditor` state factory
 * (`src/renderer/use-settings-editor.ts`).
 *
 * Sub-AC 5.2a requirements:
 *   ✓ useSettingsEditor accepts a current-content string.
 *   ✓ The returned hook exposes a `draft` value.
 *   ✓ The initial `draft` is exactly equal to the string passed at
 *     construction time (the primary acceptance criterion).
 *
 * Sub-AC 5.2b requirements:
 *   ✓ isDirty() returns false immediately on mount.
 *   ✓ isDirty() transitions to true after at least one edit (setDraft with
 *     a different value).
 *   ✓ No write side-effect (IPC call, file write, etc.) is invoked when the
 *     dirty flag transitions — the state change is synchronous and local.
 *
 * Sub-AC 5.2c requirements:
 *   ✓ cancel() resets draft to the original initialisation value.
 *   ✓ cancel() clears isDirty() back to false.
 *   ✓ Round-trip edit → cancel leaves both `draft` and `isDirty()` correct.
 *   ✓ No write side-effect is triggered during or after cancel().
 *
 * Test groups:
 *   A. Initialisation — draft equals construction-time string (core AC)
 *   B. Empty / nullish inputs — graceful fallback, no crash
 *   C. setDraft — updating draft changes the value
 *   D. isDirty — reflects whether draft differs from original
 *   E. reset — reverts draft to original content
 *   F. commit — returns the current draft value
 *   G. Type / export surface — correct TypeScript types exported
 *   H. Multiple independent instances — no shared state between hooks
 *   I. Dirty flag transition without write side-effects (Sub-AC 5.2b)
 *   J. cancel() — round-trip edit → cancel (Sub-AC 5.2c)
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  useSettingsEditor,
  type SettingsEditorHook,
} from '../../src/renderer/use-settings-editor';

// ---------------------------------------------------------------------------
// A. Initialisation — draft equals construction-time string (CORE AC 5.2a)
// ---------------------------------------------------------------------------

describe('A. useSettingsEditor — initial draft equals construction-time string', () => {
  it('A01 — initial draft is exactly equal to the string passed in', () => {
    const content = 'Hello, world!';
    const hook = useSettingsEditor(content);
    expect(hook.draft).toBe(content);
  });

  it('A02 — initial draft with a markdown systemlaw string', () => {
    const content = '## System Law\n\n- Be concise.\n- Respond in Korean when asked.';
    const hook = useSettingsEditor(content);
    expect(hook.draft).toBe(content);
  });

  it('A03 — initial draft with an Owner.md persona string', () => {
    const content = '# Owner\n\nI am a legal professional working in Seoul.';
    const hook = useSettingsEditor(content);
    expect(hook.draft).toBe(content);
  });

  it('A04 — initial draft preserves multi-line content exactly', () => {
    const content = 'Line 1\nLine 2\nLine 3\n';
    const hook = useSettingsEditor(content);
    expect(hook.draft).toBe(content);
  });

  it('A05 — initial draft preserves leading and trailing whitespace', () => {
    const content = '  trimmed?  \n  not trimmed  ';
    const hook = useSettingsEditor(content);
    expect(hook.draft).toBe(content);
  });

  it('A06 — initial draft preserves Korean text exactly', () => {
    const content = '안녕하세요. 저는 법률 전문가입니다.';
    const hook = useSettingsEditor(content);
    expect(hook.draft).toBe(content);
  });

  it('A07 — initial draft preserves emoji / unicode', () => {
    const content = 'Rules 🎉: always be kind.';
    const hook = useSettingsEditor(content);
    expect(hook.draft).toBe(content);
  });

  it('A08 — initial draft is the SAME string reference value (strict equality)', () => {
    const content = 'strict equality check';
    const hook = useSettingsEditor(content);
    // Strict equality (toBe) checks value identity — the draft string must
    // equal the passed-in string character-for-character.
    expect(hook.draft).toBe(content);
  });

  it('A09 — initial draft for a very long file content string', () => {
    const content = 'x'.repeat(50_000);
    const hook = useSettingsEditor(content);
    expect(hook.draft).toBe(content);
    expect(hook.draft.length).toBe(50_000);
  });

  it('A10 — construction does not throw for any normal string', () => {
    const cases = [
      'simple',
      '## Heading\n\nParagraph.',
      'Fish & Chips',
      '<script>alert(1)</script>',
      'It\'s fine.',
    ];
    for (const content of cases) {
      expect(() => useSettingsEditor(content)).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// B. Empty / nullish inputs — graceful fallback, no crash
// ---------------------------------------------------------------------------

describe('B. useSettingsEditor — empty / nullish input handling', () => {
  it('B01 — initial draft is empty string when empty string is passed', () => {
    const hook = useSettingsEditor('');
    expect(hook.draft).toBe('');
  });

  it('B02 — does not throw when empty string is passed', () => {
    expect(() => useSettingsEditor('')).not.toThrow();
  });

  it('B03 — initial draft normalises null-ish input to empty string', () => {
    // Cast to string to simulate callers passing result of a nullable read.
    const hook = useSettingsEditor(null as unknown as string);
    expect(hook.draft).toBe('');
  });

  it('B04 — initial draft normalises undefined input to empty string', () => {
    const hook = useSettingsEditor(undefined as unknown as string);
    expect(hook.draft).toBe('');
  });

  it('B05 — hook is returned even for empty/nullish inputs (no throw)', () => {
    const hook = useSettingsEditor(null as unknown as string);
    expect(hook).toBeDefined();
    expect(typeof hook.draft).toBe('string');
  });

  it('B06 — initial draft is exactly whitespace when whitespace-only string is passed', () => {
    const content = '   \n   ';
    const hook = useSettingsEditor(content);
    expect(hook.draft).toBe(content);
  });
});

// ---------------------------------------------------------------------------
// C. setDraft — updating draft changes the value
// ---------------------------------------------------------------------------

describe('C. useSettingsEditor — setDraft updates the draft', () => {
  it('C01 — setDraft changes draft to the new value', () => {
    const hook = useSettingsEditor('original');
    hook.setDraft('updated');
    expect(hook.draft).toBe('updated');
  });

  it('C02 — setDraft to empty string sets draft to empty string', () => {
    const hook = useSettingsEditor('some content');
    hook.setDraft('');
    expect(hook.draft).toBe('');
  });

  it('C03 — multiple setDraft calls: last value wins', () => {
    const hook = useSettingsEditor('start');
    hook.setDraft('middle');
    hook.setDraft('end');
    expect(hook.draft).toBe('end');
  });

  it('C04 — setDraft normalises null to empty string (graceful fallback)', () => {
    const hook = useSettingsEditor('original');
    hook.setDraft(null as unknown as string);
    expect(hook.draft).toBe('');
  });

  it('C05 — draft after setDraft does not equal original when values differ', () => {
    const hook = useSettingsEditor('original');
    hook.setDraft('changed');
    expect(hook.draft).not.toBe('original');
  });
});

// ---------------------------------------------------------------------------
// D. isDirty — reflects whether draft differs from original
// ---------------------------------------------------------------------------

describe('D. useSettingsEditor — isDirty', () => {
  it('D01 — isDirty is false immediately after construction', () => {
    const hook = useSettingsEditor('content');
    expect(hook.isDirty()).toBe(false);
  });

  it('D02 — isDirty is false when setDraft is called with the same value', () => {
    const content = 'same value';
    const hook = useSettingsEditor(content);
    hook.setDraft(content);
    expect(hook.isDirty()).toBe(false);
  });

  it('D03 — isDirty is true after setDraft with a different value', () => {
    const hook = useSettingsEditor('original');
    hook.setDraft('changed');
    expect(hook.isDirty()).toBe(true);
  });

  it('D04 — isDirty is false for empty string constructed and empty string draft', () => {
    const hook = useSettingsEditor('');
    expect(hook.isDirty()).toBe(false);
  });

  it('D05 — isDirty becomes false again after reset', () => {
    const hook = useSettingsEditor('original');
    hook.setDraft('dirty');
    expect(hook.isDirty()).toBe(true);
    hook.reset();
    expect(hook.isDirty()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// E. reset — reverts draft to original content
// ---------------------------------------------------------------------------

describe('E. useSettingsEditor — reset', () => {
  it('E01 — reset reverts draft to the original construction-time value', () => {
    const original = 'original content';
    const hook = useSettingsEditor(original);
    hook.setDraft('modified content');
    hook.reset();
    expect(hook.draft).toBe(original);
  });

  it('E02 — reset on an unmodified hook leaves draft unchanged', () => {
    const original = 'untouched';
    const hook = useSettingsEditor(original);
    hook.reset();
    expect(hook.draft).toBe(original);
  });

  it('E03 — reset after multiple edits always returns to original', () => {
    const original = 'start';
    const hook = useSettingsEditor(original);
    hook.setDraft('edit 1');
    hook.setDraft('edit 2');
    hook.setDraft('edit 3');
    hook.reset();
    expect(hook.draft).toBe(original);
  });

  it('E04 — reset on empty-content hook leaves draft as empty string', () => {
    const hook = useSettingsEditor('');
    hook.setDraft('some content');
    hook.reset();
    expect(hook.draft).toBe('');
  });

  it('E05 — reset does not throw', () => {
    const hook = useSettingsEditor('content');
    expect(() => hook.reset()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// F. commit — returns the current draft value
// ---------------------------------------------------------------------------

describe('F. useSettingsEditor — commit', () => {
  it('F01 — commit returns the original content before any edits', () => {
    const content = 'commit me';
    const hook = useSettingsEditor(content);
    expect(hook.commit()).toBe(content);
  });

  it('F02 — commit returns the updated draft after setDraft', () => {
    const hook = useSettingsEditor('original');
    hook.setDraft('updated');
    expect(hook.commit()).toBe('updated');
  });

  it('F03 — commit returns empty string when draft is empty', () => {
    const hook = useSettingsEditor('something');
    hook.setDraft('');
    expect(hook.commit()).toBe('');
  });

  it('F04 — commit returns same value as reading .draft', () => {
    const hook = useSettingsEditor('same');
    hook.setDraft('edited');
    expect(hook.commit()).toBe(hook.draft);
  });

  it('F05 — commit does not mutate the draft', () => {
    const hook = useSettingsEditor('safe');
    hook.commit();
    expect(hook.draft).toBe('safe');
  });
});

// ---------------------------------------------------------------------------
// G. Type / export surface — correct TypeScript types exported
// ---------------------------------------------------------------------------

describe('G. Type and export surface', () => {
  it('G01 — useSettingsEditor is a function', () => {
    expect(typeof useSettingsEditor).toBe('function');
  });

  it('G02 — useSettingsEditor returns an object', () => {
    const hook = useSettingsEditor('test');
    expect(typeof hook).toBe('object');
    expect(hook).not.toBeNull();
  });

  it('G03 — returned hook has draft property', () => {
    const hook = useSettingsEditor('test');
    expect('draft' in hook).toBe(true);
    expect(typeof hook.draft).toBe('string');
  });

  it('G04 — returned hook has setDraft function', () => {
    const hook = useSettingsEditor('test');
    expect(typeof hook.setDraft).toBe('function');
  });

  it('G05 — returned hook has isDirty function', () => {
    const hook = useSettingsEditor('test');
    expect(typeof hook.isDirty).toBe('function');
  });

  it('G06 — returned hook has reset function', () => {
    const hook = useSettingsEditor('test');
    expect(typeof hook.reset).toBe('function');
  });

  it('G07 — returned hook has commit function', () => {
    const hook = useSettingsEditor('test');
    expect(typeof hook.commit).toBe('function');
  });

  it('G08 — SettingsEditorHook type can be satisfied by returned object', () => {
    // TypeScript type check — if this compiles and runs, the type is correct.
    const hook: SettingsEditorHook = useSettingsEditor('typed test');
    expect(hook.draft).toBe('typed test');
  });
});

// ---------------------------------------------------------------------------
// H. Multiple independent instances — no shared state between hooks
// ---------------------------------------------------------------------------

describe('H. useSettingsEditor — multiple independent instances', () => {
  it('H01 — two hooks with different content have independent drafts', () => {
    const hookA = useSettingsEditor('Content A');
    const hookB = useSettingsEditor('Content B');
    expect(hookA.draft).toBe('Content A');
    expect(hookB.draft).toBe('Content B');
  });

  it('H02 — editing one hook does not affect another', () => {
    const hookA = useSettingsEditor('original');
    const hookB = useSettingsEditor('original');
    hookA.setDraft('modified');
    expect(hookB.draft).toBe('original');
  });

  it('H03 — resetting one hook does not affect another', () => {
    const hookA = useSettingsEditor('shared start');
    const hookB = useSettingsEditor('shared start');
    hookA.setDraft('edited A');
    hookB.setDraft('edited B');
    hookA.reset();
    expect(hookA.draft).toBe('shared start');
    expect(hookB.draft).toBe('edited B');  // hookB unaffected
  });

  it('H04 — isDirty is independent between hooks', () => {
    const hookA = useSettingsEditor('same');
    const hookB = useSettingsEditor('same');
    hookA.setDraft('different');
    expect(hookA.isDirty()).toBe(true);
    expect(hookB.isDirty()).toBe(false);
  });

  it('H05 — many hooks created sequentially are all independent', () => {
    const hooks = Array.from({ length: 10 }, (_, i) =>
      useSettingsEditor(`content-${i}`),
    );
    hooks.forEach((hook, i) => {
      expect(hook.draft).toBe(`content-${i}`);
    });
  });
});

// ---------------------------------------------------------------------------
// I. Dirty flag transition without write side-effects (Sub-AC 5.2b)
//
// These tests verify the three-part requirement of Sub-AC 5.2b:
//   1. isDirty() returns false immediately on mount.
//   2. isDirty() transitions to true after at least one edit.
//   3. No write side-effect (IPC call, file I/O, etc.) is invoked when the
//      dirty flag changes — the state machine is purely synchronous/local.
//
// Spy approach: vi.stubGlobal injects a mock `window.api` object that would
// exist in the Electron renderer context.  If useSettingsEditor ever wired
// up an IPC call on draft mutation, these spies would catch it.  Stubs are
// torn down via vi.unstubAllGlobals() in afterEach so tests are isolated.
// ---------------------------------------------------------------------------

describe('I. useSettingsEditor — dirty flag transitions without write side-effects (Sub-AC 5.2b)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ── Part 1: dirty is false on mount ──────────────────────────────────────

  it('I01 — isDirty() is false immediately on mount for a non-empty string', () => {
    const hook = useSettingsEditor('initial content');
    expect(hook.isDirty()).toBe(false);
  });

  it('I02 — isDirty() is false immediately on mount for an empty string', () => {
    const hook = useSettingsEditor('');
    expect(hook.isDirty()).toBe(false);
  });

  it('I03 — isDirty() is false immediately on mount for a long markdown string', () => {
    const content = '# System Law\n\n' + '- Rule.\n'.repeat(100);
    const hook = useSettingsEditor(content);
    expect(hook.isDirty()).toBe(false);
  });

  // ── Part 2: dirty transitions to true after at least one edit ─────────────

  it('I04 — isDirty() transitions from false to true on the very first edit', () => {
    const hook = useSettingsEditor('original');
    expect(hook.isDirty()).toBe(false);   // false on mount
    hook.setDraft('changed');
    expect(hook.isDirty()).toBe(true);    // true after first edit
  });

  it('I05 — a single character change is sufficient to make isDirty() true', () => {
    const hook = useSettingsEditor('abc');
    hook.setDraft('abx');  // only last character changed
    expect(hook.isDirty()).toBe(true);
  });

  it('I06 — appending to the draft makes isDirty() true', () => {
    const base = 'base content';
    const hook = useSettingsEditor(base);
    hook.setDraft(base + ' appended');
    expect(hook.isDirty()).toBe(true);
  });

  it('I07 — setting draft to empty string (when original was non-empty) makes isDirty() true', () => {
    const hook = useSettingsEditor('non-empty');
    hook.setDraft('');
    expect(hook.isDirty()).toBe(true);
  });

  // ── Part 3: no write side-effect when dirty flag transitions ─────────────

  it('I08 — setDraft does not call window.api.saveFile when dirty transitions to true', () => {
    const saveFileSpy = vi.fn();
    vi.stubGlobal('window', { api: { saveFile: saveFileSpy } });

    const hook = useSettingsEditor('content');
    hook.setDraft('new content');

    expect(hook.isDirty()).toBe(true);
    expect(saveFileSpy).not.toHaveBeenCalled();
  });

  it('I09 — setDraft does not call window.api.sessionWrite when dirty transitions to true', () => {
    const sessionWriteSpy = vi.fn();
    vi.stubGlobal('window', { api: { sessionWrite: sessionWriteSpy } });

    const hook = useSettingsEditor('content');
    hook.setDraft('modified content');

    expect(hook.isDirty()).toBe(true);
    expect(sessionWriteSpy).not.toHaveBeenCalled();
  });

  it('I10 — no IPC method in window.api is called during the dirty flag transition', () => {
    const saveFileSpy = vi.fn();
    const sessionWriteSpy = vi.fn();
    const aiChatSpy = vi.fn();
    const aiCancelSpy = vi.fn();
    const sessionGetSpy = vi.fn();
    const sessionClearSpy = vi.fn();

    vi.stubGlobal('window', {
      api: {
        saveFile: saveFileSpy,
        sessionWrite: sessionWriteSpy,
        aiChat: aiChatSpy,
        aiCancel: aiCancelSpy,
        sessionGet: sessionGetSpy,
        sessionClear: sessionClearSpy,
      },
    });

    const hook = useSettingsEditor('start');
    expect(hook.isDirty()).toBe(false);
    hook.setDraft('end');
    expect(hook.isDirty()).toBe(true);

    expect(saveFileSpy).not.toHaveBeenCalled();
    expect(sessionWriteSpy).not.toHaveBeenCalled();
    expect(aiChatSpy).not.toHaveBeenCalled();
    expect(aiCancelSpy).not.toHaveBeenCalled();
    expect(sessionGetSpy).not.toHaveBeenCalled();
    expect(sessionClearSpy).not.toHaveBeenCalled();
  });

  it('I11 — multiple edits never trigger any write side-effect', () => {
    const saveFileSpy = vi.fn();
    const sessionWriteSpy = vi.fn();
    vi.stubGlobal('window', {
      api: { saveFile: saveFileSpy, sessionWrite: sessionWriteSpy },
    });

    const hook = useSettingsEditor('initial');
    hook.setDraft('edit 1');
    hook.setDraft('edit 2');
    hook.setDraft('edit 3');

    expect(hook.isDirty()).toBe(true);
    expect(saveFileSpy).not.toHaveBeenCalled();
    expect(sessionWriteSpy).not.toHaveBeenCalled();
  });

  it('I12 — reset after dirty transition invokes no write side-effect', () => {
    const saveFileSpy = vi.fn();
    vi.stubGlobal('window', { api: { saveFile: saveFileSpy } });

    const hook = useSettingsEditor('content');
    hook.setDraft('changed');           // dirty → true
    expect(hook.isDirty()).toBe(true);
    hook.reset();                       // dirty → false
    expect(hook.isDirty()).toBe(false);

    // Neither the dirty transition NOR the clean-up via reset wrote anything
    expect(saveFileSpy).not.toHaveBeenCalled();
  });

  it('I13 — dirty flag transition is synchronous (no async I/O needed)', () => {
    // Verify the entire false→true transition is synchronous.
    // If any write were async, dirty would flip without a write completing —
    // but the point is: there is NO write at all.
    let writeCount = 0;
    const asyncWriteSpy = vi.fn(async () => { writeCount++; });
    vi.stubGlobal('window', { api: { writeUserDataFile: asyncWriteSpy } });

    const hook = useSettingsEditor('sync test');

    // Before edit
    expect(hook.isDirty()).toBe(false);
    expect(writeCount).toBe(0);

    // First edit — synchronously transitions dirty flag
    hook.setDraft('now dirty');
    expect(hook.isDirty()).toBe(true);

    // No async write was fired either
    expect(asyncWriteSpy).not.toHaveBeenCalled();
    expect(writeCount).toBe(0);
  });

  it('I14 — the isDirty transition is driven solely by string comparison, not I/O', () => {
    // This test documents the implementation contract explicitly:
    // isDirty() compares draft to original in-memory — no I/O involved.
    const hook = useSettingsEditor('reference');

    // draft === original → clean
    expect(hook.isDirty()).toBe(false);

    // draft !== original → dirty
    hook.setDraft('different');
    expect(hook.isDirty()).toBe(true);

    // Resetting the draft back to original value → clean again
    hook.setDraft('reference');
    expect(hook.isDirty()).toBe(false);

    // All of the above purely by value comparison — no write was ever needed
  });
});

// ---------------------------------------------------------------------------
// J. cancel() — round-trip edit → cancel (Sub-AC 5.2c)
//
// These tests verify the three-part requirement of Sub-AC 5.2c:
//   1. After edit → cancel, `draft` equals the original initialisation value.
//   2. After edit → cancel, `isDirty()` returns false.
//   3. No write side-effect (IPC call, file I/O, etc.) is triggered during
//      or after cancel().
//
// cancel() is the semantically explicit "Cancel button" counterpart to the
// internal reset() utility.  Both perform the same state reversal; cancel()
// is the public affordance the settings UI should bind to.
// ---------------------------------------------------------------------------

describe('J. useSettingsEditor — cancel() round-trip (Sub-AC 5.2c)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ── Part 1: cancel() exists and is callable ───────────────────────────────

  it('J01 — cancel is a function on the returned hook', () => {
    const hook = useSettingsEditor('content');
    expect(typeof hook.cancel).toBe('function');
  });

  it('J02 — cancel() does not throw', () => {
    const hook = useSettingsEditor('content');
    expect(() => hook.cancel()).not.toThrow();
  });

  it('J03 — cancel() does not throw on an unedited hook', () => {
    const hook = useSettingsEditor('');
    expect(() => hook.cancel()).not.toThrow();
  });

  // ── Part 2: draft is restored to original after edit → cancel ────────────

  it('J04 — after edit → cancel, draft equals the original construction-time value', () => {
    const original = 'original content';
    const hook = useSettingsEditor(original);
    hook.setDraft('modified content');
    hook.cancel();
    expect(hook.draft).toBe(original);
  });

  it('J05 — after edit → cancel, draft does NOT equal the edited value', () => {
    const hook = useSettingsEditor('before');
    hook.setDraft('after');
    hook.cancel();
    expect(hook.draft).not.toBe('after');
  });

  it('J06 — cancel() restores draft after multiple edits in sequence', () => {
    const original = 'start';
    const hook = useSettingsEditor(original);
    hook.setDraft('edit 1');
    hook.setDraft('edit 2');
    hook.setDraft('edit 3');
    hook.cancel();
    expect(hook.draft).toBe(original);
  });

  it('J07 — cancel() on a hook initialised with empty string restores to empty string', () => {
    const hook = useSettingsEditor('');
    hook.setDraft('was empty, now edited');
    hook.cancel();
    expect(hook.draft).toBe('');
  });

  it('J08 — cancel() on a hook initialised with Korean text restores Korean text exactly', () => {
    const original = '안녕하세요. 저는 법률 전문가입니다.';
    const hook = useSettingsEditor(original);
    hook.setDraft('English replacement');
    hook.cancel();
    expect(hook.draft).toBe(original);
  });

  it('J09 — cancel() on a hook initialised with a long markdown string restores it exactly', () => {
    const original = '# System Law\n\n' + '- Rule.\n'.repeat(200);
    const hook = useSettingsEditor(original);
    hook.setDraft('short replacement');
    hook.cancel();
    expect(hook.draft).toBe(original);
  });

  it('J10 — cancel() on an unedited hook leaves draft unchanged', () => {
    const original = 'untouched';
    const hook = useSettingsEditor(original);
    hook.cancel();
    expect(hook.draft).toBe(original);
  });

  // ── Part 3: isDirty() is false after edit → cancel ───────────────────────

  it('J11 — after edit → cancel, isDirty() returns false', () => {
    const hook = useSettingsEditor('original');
    hook.setDraft('dirty');
    expect(hook.isDirty()).toBe(true);  // confirm dirty before cancel
    hook.cancel();
    expect(hook.isDirty()).toBe(false);
  });

  it('J12 — isDirty() is false after cancel() even when setDraft was called many times', () => {
    const hook = useSettingsEditor('base');
    hook.setDraft('a');
    hook.setDraft('b');
    hook.setDraft('c');
    hook.cancel();
    expect(hook.isDirty()).toBe(false);
  });

  it('J13 — isDirty() is false after cancel() when original was empty string', () => {
    const hook = useSettingsEditor('');
    hook.setDraft('some edit');
    hook.cancel();
    expect(hook.isDirty()).toBe(false);
  });

  it('J14 — cancel() on an unedited hook leaves isDirty() false', () => {
    const hook = useSettingsEditor('clean');
    hook.cancel();
    expect(hook.isDirty()).toBe(false);
  });

  it('J15 — both draft and isDirty() are correct simultaneously after edit → cancel (core round-trip)', () => {
    const original = 'Initial system law content';
    const hook = useSettingsEditor(original);

    // Edit phase
    hook.setDraft('User typed something different');
    expect(hook.draft).toBe('User typed something different');
    expect(hook.isDirty()).toBe(true);

    // Cancel phase
    hook.cancel();
    expect(hook.draft).toBe(original);        // draft restored ✓
    expect(hook.isDirty()).toBe(false);        // dirty cleared ✓
  });

  // ── Part 4: no write side-effect during cancel() ─────────────────────────

  it('J16 — cancel() does not call window.api.saveFile', () => {
    const saveFileSpy = vi.fn();
    vi.stubGlobal('window', { api: { saveFile: saveFileSpy } });

    const hook = useSettingsEditor('content');
    hook.setDraft('modified');
    hook.cancel();

    expect(saveFileSpy).not.toHaveBeenCalled();
  });

  it('J17 — cancel() does not call window.api.sessionWrite', () => {
    const sessionWriteSpy = vi.fn();
    vi.stubGlobal('window', { api: { sessionWrite: sessionWriteSpy } });

    const hook = useSettingsEditor('content');
    hook.setDraft('modified');
    hook.cancel();

    expect(sessionWriteSpy).not.toHaveBeenCalled();
  });

  it('J18 — no IPC method in window.api is called during edit → cancel round-trip', () => {
    const saveFileSpy = vi.fn();
    const sessionWriteSpy = vi.fn();
    const aiChatSpy = vi.fn();
    const writeUserDataFileSpy = vi.fn();

    vi.stubGlobal('window', {
      api: {
        saveFile: saveFileSpy,
        sessionWrite: sessionWriteSpy,
        aiChat: aiChatSpy,
        writeUserDataFile: writeUserDataFileSpy,
      },
    });

    const hook = useSettingsEditor('initial');
    hook.setDraft('edited value');     // edit
    hook.cancel();                     // cancel

    expect(saveFileSpy).not.toHaveBeenCalled();
    expect(sessionWriteSpy).not.toHaveBeenCalled();
    expect(aiChatSpy).not.toHaveBeenCalled();
    expect(writeUserDataFileSpy).not.toHaveBeenCalled();
  });

  it('J19 — cancel() is synchronous and leaves no pending async side-effects', () => {
    let asyncCallCount = 0;
    const asyncSpy = vi.fn(async () => { asyncCallCount++; });
    vi.stubGlobal('window', { api: { writeUserDataFile: asyncSpy } });

    const hook = useSettingsEditor('sync test');
    hook.setDraft('changed');
    hook.cancel();

    // Synchronously verifiable: no async function was even invoked
    expect(asyncSpy).not.toHaveBeenCalled();
    expect(asyncCallCount).toBe(0);
  });

  it('J20 — second cancel() after a subsequent edit also produces no side-effects', () => {
    const saveFileSpy = vi.fn();
    vi.stubGlobal('window', { api: { saveFile: saveFileSpy } });

    const original = 'original';
    const hook = useSettingsEditor(original);

    // First round-trip
    hook.setDraft('first edit');
    hook.cancel();
    expect(hook.draft).toBe(original);
    expect(hook.isDirty()).toBe(false);

    // Second round-trip
    hook.setDraft('second edit');
    hook.cancel();
    expect(hook.draft).toBe(original);
    expect(hook.isDirty()).toBe(false);

    expect(saveFileSpy).not.toHaveBeenCalled();
  });

  // ── Part 5: cancel() is independent between hook instances ───────────────

  it('J21 — cancel() on one hook does not affect another hook instance', () => {
    const hookA = useSettingsEditor('shared original');
    const hookB = useSettingsEditor('shared original');

    hookA.setDraft('edited A');
    hookB.setDraft('edited B');

    hookA.cancel();  // only hookA is cancelled

    expect(hookA.draft).toBe('shared original');
    expect(hookA.isDirty()).toBe(false);

    expect(hookB.draft).toBe('edited B');      // hookB unaffected
    expect(hookB.isDirty()).toBe(true);
  });
});
