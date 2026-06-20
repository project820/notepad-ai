// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { trapModalFocus } from '../modal-a11y';

function mountDialog(): { dialog: HTMLElement; first: HTMLButtonElement; last: HTMLButtonElement } {
  document.body.innerHTML = `
    <button id="opener">opener</button>
    <div class="modal">
      <button id="a">a</button>
      <input id="b" />
      <button id="c">c</button>
    </div>`;
  const dialog = document.querySelector('.modal') as HTMLElement;
  const first = document.getElementById('a') as HTMLButtonElement;
  const last = document.getElementById('c') as HTMLButtonElement;
  return { dialog, first, last };
}

function tab(shift = false): void {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: shift, bubbles: true }));
}

describe('trapModalFocus', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('sets aria-modal and role, and moves focus to the first focusable', () => {
    const { dialog, first } = mountDialog();
    const release = trapModalFocus({ dialog, onEscape: () => {} });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('role')).toBe('dialog');
    expect(document.activeElement).toBe(first);
    release();
  });

  it('calls onEscape when Escape is pressed', () => {
    const { dialog } = mountDialog();
    const onEscape = vi.fn();
    const release = trapModalFocus({ dialog, onEscape });
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(onEscape).toHaveBeenCalledTimes(1);
    release();
  });

  it('wraps Tab from the last focusable back to the first', () => {
    const { dialog, first, last } = mountDialog();
    const release = trapModalFocus({ dialog, onEscape: () => {} });
    last.focus();
    tab(false);
    expect(document.activeElement).toBe(first);
    release();
  });

  it('wraps Shift+Tab from the first focusable to the last', () => {
    const { dialog, first, last } = mountDialog();
    const release = trapModalFocus({ dialog, onEscape: () => {} });
    first.focus();
    tab(true);
    expect(document.activeElement).toBe(last);
    release();
  });

  it('restores focus to the opener and removes the key handler on release', () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    const { dialog } = mountDialog2(opener);
    const onEscape = vi.fn();
    const release = trapModalFocus({ dialog, onEscape });
    release();
    expect(document.activeElement).toBe(opener);
    // handler removed → Escape no longer fires onEscape
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(onEscape).not.toHaveBeenCalled();
  });
});

// Variant that keeps a pre-existing opener button focused before mounting the dialog.
function mountDialog2(opener: HTMLButtonElement): { dialog: HTMLElement } {
  const wrap = document.createElement('div');
  wrap.className = 'modal';
  wrap.innerHTML = `<button id="x">x</button>`;
  document.body.appendChild(wrap);
  opener.focus();
  return { dialog: wrap };
}
