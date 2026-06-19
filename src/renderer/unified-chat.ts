/**
 * unified-chat.ts — the single writing-collaborator chat panel (G003) that
 * replaces Side Chat (⌘J) + Bottom Chat (⌘;).
 *
 * Pure `renderUnifiedChat()` (HTML string, Node-testable) + DOM `mountUnifiedChat()`
 * that wires the composer, mode chips, and per-message apply actions to injected
 * handlers (so IPC/editor stay outside this module and the panel is DOM-testable).
 *
 * The panel renders a thread of UnifiedChatItem messages, a composer, and three
 * modes: Write (apply-oriented), Advise (conversational), and Project setup
 * (relocated Project Wizard entry point). Assistant messages render as Markdown
 * (rich, read-only) and support live streaming via `beginAssistant()`.
 */

import MarkdownIt from 'markdown-it';
import { t } from './i18n';
// @ts-expect-error — no types
import taskLists from 'markdown-it-task-lists';
import { restoreUnifiedThread, type UnifiedChatItem, type UnifiedThreadSnapshot } from './unified-chat-history';

export type ChatMode = 'write' | 'advise' | 'project';

export type UnifiedChatHandlers = {
  /** Send the composed message in the active mode. */
  onSend: (text: string, mode: ChatMode) => void;
  /** Apply an assistant message's content to the document. */
  onInsert: (text: string) => void;
  onReplace: (text: string) => void;
  onCopy: (text: string) => void;
  /** Start the relocated Project Wizard ('project' mode). */
  onProjectSetup?: () => void;
};

/** Live streaming handle for one assistant turn. */
export type AssistantStream = {
  /** Append a streamed delta and re-render the (markdown) body. */
  pushDelta: (text: string) => void;
  /** Finalize the bubble, attach apply actions, and return the trimmed text. */
  finalize: (finalText?: string) => string;
  /** Render an inline error in the bubble (terminal). */
  fail: (message: string) => void;
};

export type UnifiedChatHandle = {
  /** Append a finalized message bubble (used for restored history + completed turns). */
  addMessage: (role: 'user' | 'assistant', text: string) => void;
  /** Begin a streaming assistant bubble (deltas via the returned handle). */
  beginAssistant: () => AssistantStream;
  /** Current active mode. */
  getMode: () => ChatMode;
  /** Restore a thread from a snapshot. */
  restore: (snap: UnifiedThreadSnapshot) => void;
  /** Clear the visible thread. */
  clear: () => void;
  /** Inject a transient interactive panel (e.g. Project Wizard) into the thread. */
  showPanel: (html: string, onAction?: (action: string, panel: HTMLElement) => void) => void;
  destroy: () => void;
};

const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
  typographer: true,
}).use(taskLists, { enabled: true, label: true });

const defaultLinkOpen =
  md.renderer.rules.link_open ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const aIndex = tokens[idx].attrIndex('target');
  if (aIndex < 0) tokens[idx].attrPush(['target', '_blank']);
  else tokens[idx].attrs![aIndex][1] = '_blank';
  tokens[idx].attrSet('rel', 'noopener noreferrer');
  return defaultLinkOpen(tokens, idx, options, env, self);
};

export function renderUnifiedChat(): string {
  return `<div class="uc-root">
  <div class="uc-modes" role="tablist">
    <button class="uc-mode" data-mode="write" aria-selected="true" type="button">${t('uc.write')}</button>
    <button class="uc-mode" data-mode="advise" aria-selected="false" type="button">${t('uc.advise')}</button>
    <button class="uc-mode" data-mode="project" aria-selected="false" type="button">${t('uc.project')}</button>
  </div>
  <div class="uc-thread" role="log"></div>
  <div class="uc-composer">
    <textarea class="uc-input" rows="2" placeholder="${t('uc.placeholder')}" aria-label="${t('uc.write')}"></textarea>
    <button class="uc-send" type="button">${t('uc.send')}</button>
  </div>
</div>`;
}

/** Shell HTML for a bubble (body filled separately so we can render markdown). */
function bubbleShell(role: 'user' | 'assistant'): string {
  const apply =
    role === 'assistant'
      ? `<div class="uc-actions">
        <button class="uc-act" data-act="insert" type="button">${t('uc.insert')}</button>
        <button class="uc-act" data-act="replace" type="button">${t('uc.replace')}</button>
        <button class="uc-act" data-act="copy" type="button">${t('uc.copy')}</button>
      </div>`
      : '';
  return `<div class="uc-msg uc-${role}"><div class="uc-body"></div>${apply}</div>`;
}

export function mountUnifiedChat(parent: HTMLElement, handlers: UnifiedChatHandlers): UnifiedChatHandle {
  parent.innerHTML = renderUnifiedChat();
  const thread = parent.querySelector<HTMLElement>('.uc-thread')!;
  const input = parent.querySelector<HTMLTextAreaElement>('.uc-input')!;
  let mode: ChatMode = 'write';

  function scrollToEnd() {
    thread.scrollTop = thread.scrollHeight;
  }

  function newBubble(role: 'user' | 'assistant'): HTMLElement {
    const holder = document.createElement('div');
    holder.innerHTML = bubbleShell(role);
    return holder.firstElementChild as HTMLElement;
  }

  function renderBody(node: HTMLElement, text: string, asMarkdown: boolean) {
    const body = node.querySelector<HTMLElement>('.uc-body')!;
    if (asMarkdown) body.innerHTML = md.render(text);
    else body.textContent = text;
  }

  function addMessage(role: 'user' | 'assistant', text: string) {
    const node = newBubble(role);
    node.dataset.text = text;
    // Assistant content is rich markdown; user messages stay plain text.
    renderBody(node, text, role === 'assistant');
    thread.appendChild(node);
    scrollToEnd();
  }

  function beginAssistant(): AssistantStream {
    const node = newBubble('assistant');
    const actions = node.querySelector<HTMLElement>('.uc-actions');
    if (actions) actions.style.display = 'none';
    node.classList.add('uc-streaming');
    thread.appendChild(node);
    scrollToEnd();
    let buffer = '';
    return {
      pushDelta(text: string) {
        buffer += text;
        renderBody(node, buffer, true);
        scrollToEnd();
      },
      finalize(finalText?: string) {
        buffer = (finalText ?? buffer).trim();
        node.dataset.text = buffer;
        renderBody(node, buffer, true);
        node.classList.remove('uc-streaming');
        if (actions) actions.style.display = '';
        scrollToEnd();
        return buffer;
      },
      fail(message: string) {
        const body = node.querySelector<HTMLElement>('.uc-body')!;
        body.textContent = `⚠ ${message}`;
        body.classList.add('uc-err');
        node.classList.remove('uc-streaming');
        scrollToEnd();
      },
    };
  }

  function addSeparator(label: string) {
    const sep = document.createElement('div');
    sep.className = 'uc-separator';
    sep.textContent = label;
    thread.appendChild(sep);
  }

  function renderItems(items: UnifiedChatItem[]) {
    thread.innerHTML = '';
    for (const item of items) {
      if (item.type === 'separator') addSeparator(item.label);
      else addMessage(item.role, item.text);
    }
  }

  function showPanel(html: string, onAction?: (action: string, panel: HTMLElement) => void) {
    // Only one transient panel at a time (e.g. Project Wizard steps).
    for (const existing of Array.from(thread.querySelectorAll('.uc-panel-msg'))) existing.remove();
    const div = document.createElement('div');
    div.className = 'uc-msg uc-assistant uc-panel-msg';
    div.innerHTML = html;
    div.addEventListener('click', (event) => {
      const actionEl = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-pw-action]');
      if (!actionEl || !div.contains(actionEl)) return;
      onAction?.(actionEl.dataset.pwAction ?? '', div);
    });
    thread.appendChild(div);
    scrollToEnd();
  }

  const onModeClick = (e: Event) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('.uc-mode');
    if (!btn) return;
    mode = (btn.dataset.mode as ChatMode) ?? 'write';
    for (const m of parent.querySelectorAll<HTMLButtonElement>('.uc-mode')) {
      m.setAttribute('aria-selected', String(m === btn));
    }
    if (mode === 'project') handlers.onProjectSetup?.();
  };

  const send = () => {
    const text = input.value.trim();
    if (!text) return;
    handlers.onSend(text, mode);
    input.value = '';
  };

  const onComposerClick = (e: Event) => {
    if ((e.target as HTMLElement).closest('.uc-send')) send();
  };

  const onKeydown = (e: KeyboardEvent) => {
    if (e.isComposing || e.keyCode === 229) return; // Korean IME guard
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  const onThreadClick = (e: Event) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('.uc-act');
    if (!btn) return;
    const msg = btn.closest<HTMLElement>('.uc-msg');
    const text = msg?.dataset.text ?? '';
    if (btn.dataset.act === 'insert') handlers.onInsert(text);
    else if (btn.dataset.act === 'replace') handlers.onReplace(text);
    else if (btn.dataset.act === 'copy') handlers.onCopy(text);
  };

  parent.querySelector('.uc-modes')!.addEventListener('click', onModeClick);
  parent.querySelector('.uc-composer')!.addEventListener('click', onComposerClick);
  input.addEventListener('keydown', onKeydown);
  thread.addEventListener('click', onThreadClick);

  return {
    addMessage,
    beginAssistant,
    getMode: () => mode,
    restore: (snap) => renderItems(restoreUnifiedThread(snap)),
    clear: () => {
      thread.innerHTML = '';
    },
    showPanel,
    destroy: () => {
      parent.innerHTML = '';
    },
  };
}
