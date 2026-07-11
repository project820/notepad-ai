// @vitest-environment happy-dom
/**
 * unified-chat.redteam.dom.test.ts — adversarial red-team for the G001 4-tab
 * unified-chat shell + transient-panel lifecycle (AC2 no-wrap tab strip, AC16
 * HTML-normal-tab + gear-only-right, AC5 no lingering panel).
 *
 * These tests try to break the tab/handler/panel contract, not just confirm it.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { mountUnifiedChat, renderUnifiedChat, type UnifiedChatHandlers } from '../unified-chat';

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

function mount(over: Partial<UnifiedChatHandlers> = {}) {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const handlers: UnifiedChatHandlers = {
    onSend: vi.fn(),
    onInsert: vi.fn(),
    onReplace: vi.fn(),
    onCopy: vi.fn(),
    ...over,
  };
  const handle = mountUnifiedChat(parent, handlers);
  return { parent, handlers, handle };
}

const clickMode = (parent: HTMLElement, mode: string) =>
  parent.querySelector<HTMLButtonElement>(`.uc-mode[data-mode="${mode}"]`)!.click();

describe('renderUnifiedChat — four-tab strip, write default, no legacy export (AC2/AC16)', () => {
  it('renders the four data-mode tabs in order, write default-selected, no uc-html-export', () => {
    const html = renderUnifiedChat();
    expect(html).toContain('data-mode="write"');
    expect(html).toContain('data-mode="advise"');
    expect(html).toContain('data-mode="project"');
    expect(html).toContain('data-mode="html"');
    expect(html).toContain('data-mode="write" aria-selected="true"');
    expect(html).not.toContain('uc-html-export');
    expect(html).not.toContain('data-mode="export"');
    const order = Array.from(html.matchAll(/data-mode="([^"]+)"/g)).map((m) => m[1]);
    expect(order).toEqual(['write', 'advise', 'project', 'html']);
  });

  it('mounts exactly four .uc-mode tabs plus a single rightmost gear (AC16 gear-only-right)', () => {
    const { parent } = mount();
    const modes = parent.querySelectorAll('.uc-mode');
    expect(modes.length).toBe(4);
    expect(Array.from(modes).map((b) => (b as HTMLElement).dataset.mode)).toEqual([
      'write', 'advise', 'project', 'html',
    ]);
    const stripButtons = Array.from(parent.querySelectorAll('.uc-modes button'));
    expect(stripButtons.length).toBe(5);
    const nonMode = stripButtons.filter((b) => !b.classList.contains('uc-mode'));
    expect(nonMode.length).toBe(1);
    expect(nonMode[0].classList.contains('uc-style-toggle')).toBe(true);
    expect(stripButtons[stripButtons.length - 1]).toBe(nonMode[0]);
  });

  it('defaults to the write tab as the active mode at mount (AC2 write default)', () => {
    const { parent, handle } = mount();
    expect(handle.getMode()).toBe('write');
    const selected = parent.querySelectorAll('.uc-mode[aria-selected="true"]');
    expect(selected.length).toBe(1);
    expect((selected[0] as HTMLElement).dataset.mode).toBe('write');
  });
});

describe('mountUnifiedChat — mode routing under adversarial clicks', () => {
  it('routes each tab to the right handler and keeps exactly one tab selected', () => {
    const onModeChange = vi.fn();
    const onProjectSetup = vi.fn();
    const onHtmlExport = vi.fn();
    const { parent, handle } = mount({ onModeChange, onProjectSetup, onHtmlExport });

    clickMode(parent, 'advise');
    expect(handle.getMode()).toBe('advise');
    expect(onModeChange).toHaveBeenLastCalledWith('advise');
    expect(onProjectSetup).not.toHaveBeenCalled();
    expect(onHtmlExport).not.toHaveBeenCalled();

    clickMode(parent, 'project');
    expect(handle.getMode()).toBe('project');
    expect(onProjectSetup).toHaveBeenCalledTimes(1);

    clickMode(parent, 'html');
    expect(handle.getMode()).toBe('html');
    expect(onHtmlExport).toHaveBeenCalledTimes(1);

    clickMode(parent, 'write');
    expect(handle.getMode()).toBe('write');
    const selected = parent.querySelectorAll('.uc-mode[aria-selected="true"]');
    expect(selected.length).toBe(1);
    expect((selected[0] as HTMLElement).dataset.mode).toBe('write');
  });

  it('re-clicking the active project tab re-triggers its handler (no de-dupe guard)', () => {
    const onProjectSetup = vi.fn();
    const { parent } = mount({ onProjectSetup });
    clickMode(parent, 'project');
    clickMode(parent, 'project');
    expect(onProjectSetup).toHaveBeenCalledTimes(2);
  });

  it('does not throw when optional handlers are missing (project/html/mode-change omitted)', () => {
    const { parent, handle } = mount();
    expect(() => clickMode(parent, 'project')).not.toThrow();
    expect(handle.getMode()).toBe('project');
    expect(() => clickMode(parent, 'html')).not.toThrow();
    expect(handle.getMode()).toBe('html');
    expect(() => clickMode(parent, 'write')).not.toThrow();
    expect(handle.getMode()).toBe('write');
  });

  it('the composer never sends or wipes text on project/html tabs (no silent loss)', () => {
    const { parent, handlers } = mount({ onHtmlExport: vi.fn() });
    clickMode(parent, 'html');
    const input = parent.querySelector<HTMLTextAreaElement>('.uc-input')!;
    input.value = 'export please';
    parent.querySelector<HTMLButtonElement>('.uc-send')!.click();
    expect(handlers.onSend).not.toHaveBeenCalled();
    expect(input.value).toBe('export please'); // preserved, not silently wiped
  });
});

describe('mountUnifiedChat — transient panel lifecycle (AC5: no lingering panel)', () => {
  it('clearPanel runs onDestroy exactly once and is idempotent', () => {
    const { handle } = mount();
    const onDestroy = vi.fn();
    handle.showPanel('<div>x</div>', undefined, onDestroy);
    handle.clearPanel();
    handle.clearPanel();
    expect(onDestroy).toHaveBeenCalledTimes(1);
  });

  it('replacing a panel destroys the prior one before showing the next', () => {
    const { parent, handle } = mount();
    const firstDestroy = vi.fn();
    const secondDestroy = vi.fn();
    handle.showPanel('<div data-pw-action="a">A</div>', undefined, firstDestroy);
    handle.showPanel('<div data-pw-action="b">B</div>', undefined, secondDestroy);
    expect(firstDestroy).toHaveBeenCalledTimes(1);
    expect(secondDestroy).not.toHaveBeenCalled();
    expect(parent.querySelectorAll('.uc-panel-msg').length).toBe(1);
  });

  it('switching to write/advise tears down the panel (onDestroy fires)', () => {
    for (const target of ['write', 'advise'] as const) {
      const { parent, handle } = mount();
      const onDestroy = vi.fn();
      handle.showPanel('<div>p</div>', undefined, onDestroy);
      expect(parent.querySelectorAll('.uc-panel-msg').length).toBe(1);
      clickMode(parent, target);
      expect(onDestroy).toHaveBeenCalledTimes(1);
      expect(parent.querySelectorAll('.uc-panel-msg').length).toBe(0);
      document.body.innerHTML = '';
    }
  });

  it('switching project->html clears the stale project panel', () => {
    const { parent, handle } = mount({ onProjectSetup: vi.fn(), onHtmlExport: vi.fn() });
    const onDestroy = vi.fn();
    handle.showPanel('<div>p</div>', undefined, onDestroy);
    clickMode(parent, 'project');
    expect(onDestroy).not.toHaveBeenCalled();
    expect(parent.querySelectorAll('.uc-panel-msg').length).toBe(1);
    clickMode(parent, 'html');
    expect(onDestroy).toHaveBeenCalledTimes(1);
    expect(parent.querySelectorAll('.uc-panel-msg').length).toBe(0);
  });

  it('destroy() tears down any open panel cleanup', () => {
    const { parent, handle } = mount();
    const onDestroy = vi.fn();
    handle.showPanel('<div>p</div>', undefined, onDestroy);
    handle.destroy();
    expect(onDestroy).toHaveBeenCalledTimes(1);
    expect(parent.innerHTML).toBe('');
  });

  it('clearPanel with no panel present is a safe no-op', () => {
    const { handle } = mount();
    expect(() => handle.clearPanel()).not.toThrow();
  });
});
