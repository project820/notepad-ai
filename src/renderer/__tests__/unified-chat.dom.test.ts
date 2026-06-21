// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { mountUnifiedChat, renderUnifiedChat, type UnifiedChatHandlers } from '../unified-chat';
import { LEGACY_SIDE_SEPARATOR } from '../unified-chat-history';

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
    onProjectSetup: vi.fn(),
    ...over,
  };
  const handle = mountUnifiedChat(parent, handlers);
  return { parent, handlers, handle };
}

describe('renderUnifiedChat', () => {
  it('renders thread, composer, and four mode tabs (no separate HTML button)', () => {
    const html = renderUnifiedChat();
    expect(html).toContain('uc-thread');
    expect(html).toContain('uc-input');
    expect(html).toContain('data-mode="write"');
    expect(html).toContain('data-mode="advise"');
    expect(html).toContain('data-mode="project"');
    expect(html).toContain('data-mode="html"');
    expect(html).not.toContain('uc-html-export');
  });
});

describe('mountUnifiedChat — composer', () => {
  it('sends the composed text in the active mode and clears the input', () => {
    const { parent, handlers } = mount();
    const input = parent.querySelector<HTMLTextAreaElement>('.uc-input')!;
    input.value = 'draft an intro';
    parent.querySelector<HTMLButtonElement>('.uc-send')!.click();
    expect(handlers.onSend).toHaveBeenCalledWith('draft an intro', 'write', undefined);
    expect(input.value).toBe('');
  });

  it('does not send empty/whitespace input', () => {
    const { parent, handlers } = mount();
    parent.querySelector<HTMLTextAreaElement>('.uc-input')!.value = '   ';
    parent.querySelector<HTMLButtonElement>('.uc-send')!.click();
    expect(handlers.onSend).not.toHaveBeenCalled();
  });

  it('Enter sends, Shift+Enter does not', () => {
    const { parent, handlers } = mount();
    const input = parent.querySelector<HTMLTextAreaElement>('.uc-input')!;
    input.value = 'hi';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(handlers.onSend).toHaveBeenCalledTimes(1);
    input.value = 'more';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }));
    expect(handlers.onSend).toHaveBeenCalledTimes(1);
  });

  it('respects the Korean IME composition guard (keyCode 229)', () => {
    const { parent, handlers } = mount();
    const input = parent.querySelector<HTMLTextAreaElement>('.uc-input')!;
    input.value = '한글';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, bubbles: true } as KeyboardEventInit));
    expect(handlers.onSend).not.toHaveBeenCalled();
  });
});

describe('mountUnifiedChat — modes', () => {
  it('switches active mode and reflects it in onSend', () => {
    const { parent, handlers, handle } = mount();
    parent.querySelector<HTMLButtonElement>('.uc-mode[data-mode="advise"]')!.click();
    expect(handle.getMode()).toBe('advise');
    const input = parent.querySelector<HTMLTextAreaElement>('.uc-input')!;
    input.value = 'what do you think?';
    parent.querySelector<HTMLButtonElement>('.uc-send')!.click();
    expect(handlers.onSend).toHaveBeenCalledWith('what do you think?', 'advise', undefined);
  });

  it('project mode triggers the Project Wizard handler', () => {
    const { parent, handlers } = mount();
    parent.querySelector<HTMLButtonElement>('.uc-mode[data-mode="project"]')!.click();
    expect(handlers.onProjectSetup).toHaveBeenCalledTimes(1);
  });

  it('html tab triggers the HTML-export handler', () => {
    const { parent, handlers } = mount({ onHtmlExport: vi.fn() });
    parent.querySelector<HTMLButtonElement>('.uc-mode[data-mode="html"]')!.click();
    expect(handlers.onHtmlExport).toHaveBeenCalledTimes(1);
  });

  it('switching to write clears a transient panel and notifies onModeChange', () => {
    const onModeChange = vi.fn();
    const { parent, handle } = mount({ onModeChange });
    handle.showPanel('<div data-pw-action="x">P</div>');
    expect(parent.querySelectorAll('.uc-panel-msg').length).toBe(1);
    parent.querySelector<HTMLButtonElement>('.uc-mode[data-mode="write"]')!.click();
    expect(parent.querySelectorAll('.uc-panel-msg').length).toBe(0);
    expect(onModeChange).toHaveBeenCalledWith('write');
  });

  it('clearPanel runs the panel onDestroy cleanup', () => {
    const { handle } = mount();
    const onDestroy = vi.fn();
    handle.showPanel('<div>x</div>', undefined, onDestroy);
    handle.clearPanel();
    expect(onDestroy).toHaveBeenCalledTimes(1);
  });
});

describe('mountUnifiedChat — apply actions', () => {
  it('assistant messages expose insert/replace/copy wired to handlers', () => {
    const { parent, handlers, handle } = mount();
    handle.addMessage('assistant', 'generated text');
    const msg = parent.querySelector<HTMLElement>('.uc-assistant')!;
    msg.querySelector<HTMLButtonElement>('[data-act="insert"]')!.click();
    msg.querySelector<HTMLButtonElement>('[data-act="replace"]')!.click();
    msg.querySelector<HTMLButtonElement>('[data-act="copy"]')!.click();
    expect(handlers.onInsert).toHaveBeenCalledWith('generated text');
    expect(handlers.onReplace).toHaveBeenCalledWith('generated text');
    expect(handlers.onCopy).toHaveBeenCalledWith('generated text');
  });

  it('user messages have no apply actions', () => {
    const { parent, handle } = mount();
    handle.addMessage('user', 'my question');
    const msg = parent.querySelector<HTMLElement>('.uc-user')!;
    expect(msg.querySelector('.uc-act')).toBeNull();
  });

  it('escapes HTML in message bodies', () => {
    const { parent, handle } = mount();
    handle.addMessage('assistant', '<img src=x onerror=alert(1)>');
    const body = parent.querySelector<HTMLElement>('.uc-assistant .uc-body')!;
    expect(body.querySelector('img')).toBeNull();
    expect(body.textContent).toContain('<img');
  });
});

describe('mountUnifiedChat — restore from history', () => {
  it('renders merged legacy history with a Legacy Side Chat separator', () => {
    const { parent, handle } = mount();
    handle.restore({
      chatHistory: [{ role: 'user', text: 'b' }],
      sideChatHistory: [{ role: 'assistant', text: 's' }],
    });
    expect(parent.querySelector('.uc-separator')!.textContent).toBe(LEGACY_SIDE_SEPARATOR);
    expect(parent.querySelectorAll('.uc-msg').length).toBe(2);
  });
});
describe('mountUnifiedChat — streaming assistant', () => {
  it('renders streamed deltas as markdown and attaches apply actions on finalize', () => {
    const { parent, handlers, handle } = mount();
    const stream = handle.beginAssistant();
    const node = parent.querySelector<HTMLElement>('.uc-assistant')!;
    expect(node.classList.contains('uc-streaming')).toBe(true);
    // actions hidden while streaming
    expect(node.querySelector<HTMLElement>('.uc-actions')!.style.display).toBe('none');

    stream.pushDelta('Hello ');
    stream.pushDelta('**world**');
    expect(node.querySelector('.uc-body strong')).not.toBeNull();

    const final = stream.finalize();
    expect(final).toBe('Hello **world**');
    expect(node.classList.contains('uc-streaming')).toBe(false);
    expect(node.querySelector<HTMLElement>('.uc-actions')!.style.display).toBe('');
    expect(node.dataset.text).toBe('Hello **world**');

    node.querySelector<HTMLButtonElement>('[data-act="insert"]')!.click();
    expect(handlers.onInsert).toHaveBeenCalledWith('Hello **world**');
  });

  it('finalize prefers an explicit final text and trims it', () => {
    const { parent, handle } = mount();
    const stream = handle.beginAssistant();
    stream.pushDelta('partial');
    const final = stream.finalize('  full answer  ');
    expect(final).toBe('full answer');
    expect(parent.querySelector<HTMLElement>('.uc-assistant')!.dataset.text).toBe('full answer');
  });

  it('fail() renders an inline error and clears streaming state', () => {
    const { parent, handle } = mount();
    const stream = handle.beginAssistant();
    stream.fail('rate limited');
    const body = parent.querySelector<HTMLElement>('.uc-assistant .uc-body')!;
    expect(body.textContent).toContain('rate limited');
    expect(body.classList.contains('uc-err')).toBe(true);
    expect(parent.querySelector<HTMLElement>('.uc-assistant')!.classList.contains('uc-streaming')).toBe(false);
  });

  it('fail() after partial streaming preserves the partial answer + exposes copy actions', () => {
    const { parent, handle } = mount();
    const stream = handle.beginAssistant();
    stream.pushDelta('Here is the start of the answer');
    stream.fail('connection lost');
    const node = parent.querySelector<HTMLElement>('.uc-assistant')!;
    const body = node.querySelector<HTMLElement>('.uc-body')!;
    // partial content is kept (not wiped), the error is shown as a separate note,
    // streaming state is cleared, the copyable text is retained, and actions are shown.
    expect(body.textContent).toContain('Here is the start of the answer');
    expect(body.querySelector('.uc-err')?.textContent).toContain('connection lost');
    expect(node.dataset.text).toContain('Here is the start of the answer');
    expect(node.classList.contains('uc-streaming')).toBe(false);
    const actions = node.querySelector<HTMLElement>('.uc-actions');
    expect(actions && actions.style.display).not.toBe('none');
  });
});

describe('mountUnifiedChat — showPanel', () => {
  it('injects an interactive panel and dispatches data-pw-action clicks', () => {
    const { parent, handle } = mount();
    const onAction = vi.fn();
    handle.showPanel('<button data-pw-action="start" type="button">Start</button>', onAction);
    const panel = parent.querySelector<HTMLElement>('.uc-panel-msg')!;
    expect(panel).not.toBeNull();
    panel.querySelector<HTMLButtonElement>('[data-pw-action="start"]')!.click();
    expect(onAction).toHaveBeenCalledWith('start', panel);
  });

  it('replaces a prior panel (only one at a time)', () => {
    const { parent, handle } = mount();
    handle.showPanel('<div data-pw-action="a">A</div>');
    handle.showPanel('<div data-pw-action="b">B</div>');
    expect(parent.querySelectorAll('.uc-panel-msg').length).toBe(1);
  });
});

describe('mountUnifiedChat — write help + advise sync (AC3/AC6)', () => {
  it('shows the write-help on an empty write thread and hides it after a message', () => {
    const { parent, handle } = mount();
    const help = parent.querySelector<HTMLElement>('.uc-write-help')!;
    expect(help).not.toBeNull();
    expect(help.hidden).toBe(false); // write is the default tab + empty thread
    handle.addMessage('user', 'hello');
    expect(help.hidden).toBe(true);
  });

  it('hides the write-help when not on the write tab', () => {
    const { parent } = mount();
    const help = parent.querySelector<HTMLElement>('.uc-write-help')!;
    parent.querySelector<HTMLButtonElement>('.uc-mode[data-mode="advise"]')!.click();
    expect(help.hidden).toBe(true);
  });

  it('shows the advise sync bar only on the advise tab', () => {
    const { parent } = mount();
    const bar = parent.querySelector<HTMLElement>('.uc-advise-bar')!;
    expect(bar.hidden).toBe(true); // default write
    parent.querySelector<HTMLButtonElement>('.uc-mode[data-mode="advise"]')!.click();
    expect(bar.hidden).toBe(false);
    parent.querySelector<HTMLButtonElement>('.uc-mode[data-mode="write"]')!.click();
    expect(bar.hidden).toBe(true);
  });

  it('the resync button invokes onAdviceResync', () => {
    const onAdviceResync = vi.fn();
    const { parent } = mount({ onAdviceResync });
    parent.querySelector<HTMLButtonElement>('.uc-mode[data-mode="advise"]')!.click();
    parent.querySelector<HTMLButtonElement>('.uc-advise-resync')!.click();
    expect(onAdviceResync).toHaveBeenCalledTimes(1);
  });

  it('setAdviceSync updates the sync status badge', () => {
    const { parent, handle } = mount();
    handle.setAdviceSync('Document synced · 14:32');
    expect(parent.querySelector('.uc-advise-status')!.textContent).toBe('Document synced · 14:32');
  });
});

describe('mountUnifiedChat — image attachments (G007 AC14)', () => {
  const att = { mime: 'image/png', base64: 'AAAA', bytes: 10, name: 'shot.png' };

  it('renders a chip per attachment and removes it on ×', () => {
    const { parent, handle } = mount();
    handle.addAttachment(att);
    const chips = parent.querySelector<HTMLElement>('.uc-chips')!;
    expect(chips.hidden).toBe(false);
    expect(chips.querySelectorAll('.uc-chip').length).toBe(1);
    chips.querySelector<HTMLButtonElement>('.uc-chip-x')!.click();
    expect(chips.querySelectorAll('.uc-chip').length).toBe(0);
    expect(chips.hidden).toBe(true);
  });

  it('send passes the attachments and clears them afterward', () => {
    const { parent, handlers, handle } = mount();
    handle.addAttachment(att);
    const input = parent.querySelector<HTMLTextAreaElement>('.uc-input')!;
    input.value = 'OCR this';
    parent.querySelector<HTMLButtonElement>('.uc-send')!.click();
    expect(handlers.onSend).toHaveBeenCalledWith('OCR this', 'write', [att]);
    expect(parent.querySelector<HTMLElement>('.uc-chips')!.querySelectorAll('.uc-chip').length).toBe(0);
  });

  it('allows an image-only turn (empty text but attachment present)', () => {
    const { parent, handlers, handle } = mount();
    handle.addAttachment(att);
    parent.querySelector<HTMLButtonElement>('.uc-send')!.click();
    expect(handlers.onSend).toHaveBeenCalledWith('', 'write', [att]);
  });

  it('the attach button opens the hidden file input', () => {
    const { parent } = mount();
    const file = parent.querySelector<HTMLInputElement>('.uc-file')!;
    const clickSpy = vi.spyOn(file, 'click');
    parent.querySelector<HTMLButtonElement>('.uc-attach')!.click();
    expect(clickSpy).toHaveBeenCalledTimes(1);
  });
});
