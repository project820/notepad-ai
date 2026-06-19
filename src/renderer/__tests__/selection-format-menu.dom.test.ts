// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { installSelectionFormatMenu, type SelectionFormatMenuDeps } from '../selection-format-menu';
import { t } from '../i18n';

let uninstall: (() => void) | null = null;

function setup(over: Partial<SelectionFormatMenuDeps> = {}) {
  document.body.innerHTML = `
    <div id="editor"><div class="cm-line"><span id="ed-text">editor text</span></div></div>
    <div id="preview" contenteditable="true"><p id="pv-text">preview text</p>
      <div class="preview-table-wrap" contenteditable="false"><table><tbody><tr><td id="cell">cell</td></tr></tbody></table></div>
    </div>
    <button class="ba-pill" id="pill">AI</button>
  `;
  const editorEl = document.getElementById('editor') as HTMLElement;
  const previewEl = document.getElementById('preview') as HTMLElement;
  const dispatchFormat = vi.fn();
  const deps: SelectionFormatMenuDeps = {
    editorEl,
    previewEl,
    hasEditorSelection: () => false,
    dispatchFormat,
    ...over,
  };
  uninstall = installSelectionFormatMenu(deps);
  return { editorEl, previewEl, dispatchFormat };
}

function rightClick(target: Element): MouseEvent {
  const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 12, clientY: 18 });
  target.dispatchEvent(ev);
  return ev;
}

function menu(): HTMLElement | null {
  return document.querySelector('.selection-ctx-menu');
}

afterEach(() => {
  uninstall?.();
  uninstall = null;
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('selection-format-menu (#5 · AC6)', () => {
  it('opens on a non-empty EDITOR selection and dispatches against the editor surface', () => {
    const { dispatchFormat } = setup({ hasEditorSelection: () => true });
    const ev = rightClick(document.getElementById('ed-text')!);
    expect(ev.defaultPrevented).toBe(true);
    const m = menu();
    expect(m).not.toBeNull();
    // toolbar-parity subset is present
    expect(m!.querySelector('[data-action="bold"]')!.textContent).toBe(t('ctx.bold'));
    expect(m!.querySelector('[data-action="footnote"]')).not.toBeNull();

    m!.querySelector<HTMLButtonElement>('[data-action="italic"]')!.click();
    expect(dispatchFormat).toHaveBeenCalledWith('italic', 'editor');
    // menu closes after a choice
    expect(menu()).toBeNull();
  });

  it('opens on a non-empty PREVIEW selection and dispatches against the preview surface', () => {
    const { previewEl, dispatchFormat } = setup();
    const pvText = document.getElementById('pv-text')!;
    vi.spyOn(window, 'getSelection').mockReturnValue({
      isCollapsed: false,
      toString: () => 'preview',
      anchorNode: pvText,
    } as unknown as Selection);

    const ev = rightClick(pvText);
    expect(ev.defaultPrevented).toBe(true);
    expect(menu()).not.toBeNull();

    menu()!.querySelector<HTMLButtonElement>('[data-action="bold"]')!.click();
    expect(dispatchFormat).toHaveBeenCalledWith('bold', 'preview');
    expect(previewEl).toBeTruthy();
  });

  it('does NOT open inside a table cell (table menu wins) and leaves the native menu', () => {
    const { dispatchFormat } = setup();
    // even with a live preview selection anchored in the cell
    vi.spyOn(window, 'getSelection').mockReturnValue({
      isCollapsed: false,
      toString: () => 'cell',
      anchorNode: document.getElementById('cell'),
    } as unknown as Selection);

    const ev = rightClick(document.getElementById('cell')!);
    expect(menu()).toBeNull();
    expect(ev.defaultPrevented).toBe(false);
    expect(dispatchFormat).not.toHaveBeenCalled();
  });

  it('does NOT open inside the Block AI pill', () => {
    setup({ hasEditorSelection: () => true });
    const ev = rightClick(document.getElementById('pill')!);
    expect(menu()).toBeNull();
    expect(ev.defaultPrevented).toBe(false);
  });

  it('does NOT open when there is no selection (native menu preserved)', () => {
    setup({ hasEditorSelection: () => false });
    const ev = rightClick(document.getElementById('ed-text')!);
    expect(menu()).toBeNull();
    expect(ev.defaultPrevented).toBe(false);
  });

  it('ignores a collapsed preview selection', () => {
    setup();
    vi.spyOn(window, 'getSelection').mockReturnValue({
      isCollapsed: true,
      toString: () => '',
      anchorNode: document.getElementById('pv-text'),
    } as unknown as Selection);
    const ev = rightClick(document.getElementById('pv-text')!);
    expect(menu()).toBeNull();
    expect(ev.defaultPrevented).toBe(false);
  });
});
