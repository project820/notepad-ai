/**
 * unified-chat.ts — the single writing-collaborator chat panel (G003) that
 * replaced the prior separate chat surfaces.
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
import { mountStyleSettingPanel, type StyleSettingHandle } from './style-setting-panel';
import type { StyleSetting } from './humanize-engine';
import { CONVERTIBLE_EXTS } from '../shared/file-types';

/** Non-image extensions read directly as UTF-8 text and attached as context. */
const TEXT_READABLE_EXTS = new Set<string>([
  'txt', 'md', 'markdown', 'mdx', 'csv', 'tsv', 'json', 'jsonl', 'yaml', 'yml', 'toml', 'ini',
  'xml', 'html', 'htm', 'css', 'log', 'rtf', 'tex', 'srt', 'vtt',
  'js', 'jsx', 'ts', 'tsx', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'c', 'h', 'cpp', 'cc', 'hpp',
  'cs', 'php', 'swift', 'sh', 'bash', 'zsh', 'sql', 'r', 'lua', 'pl', 'dart', 'scala', 'vue', 'svelte',
]);
const CONVERTIBLE_EXT_SET = new Set<string>(CONVERTIBLE_EXTS as readonly string[]);
/** Max characters of a single attached text/document fed to the model. */
const MAX_TEXT_FILE_CHARS = 100_000;

export type ChatMode = 'write' | 'advise' | 'project' | 'html';

/** A pending image attachment in the composer (base64, no data: prefix). */
export type ChatAttachment = { mime: string; base64: string; bytes: number; name?: string };

/** A pending non-image file attachment, already decoded to text for AI context. */
export type ChatTextAttachment = { name: string; text: string; bytes: number };

/** Valid only while the tab activation that started a tool handler remains selected. */
export type ToolPanelGuard = {
  isCurrent: () => boolean;
};

export type UnifiedChatHandlers = {
  /** Send the composed message (with any image attachments) in the active mode. */
  onSend: (
    text: string,
    mode: ChatMode,
    attachments?: ChatAttachment[],
    textFiles?: ChatTextAttachment[],
  ) => void;
  /** Convert an attached document (PDF/DOCX/HWP/XLSX) buffer to Markdown for context. */
  convertFile?: (base64: string, ext: string, name: string) => Promise<{ ok: boolean; markdown?: string; error?: string }>;
  /** Apply an assistant message's content to the document. */
  onInsert: (text: string) => void;
  onReplace: (text: string) => void;
  onCopy: (text: string) => void;
  /** Start the relocated Project Wizard ('project' mode). */
  onProjectSetup?: (guard: ToolPanelGuard) => void;
  /** Open the HTML-export wizard (its own tab). */
  onHtmlExport?: (guard: ToolPanelGuard) => void;
  /** Notify the host when the active tab changes (write/advise/project/html). */
  onModeChange?: (mode: ChatMode) => void;
  /** Advise tab: user pressed "sync now" to re-snapshot the live document. */
  onAdviceResync?: () => void;
  /** AI writing style (difficulty + naturalness), surfaced inline in the chat. */
  style?: { get: () => StyleSetting; onChange: (s: StyleSetting) => void };
};

/** Live streaming handle for one assistant turn. */
type AssistantStream = {
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
  /** Inject a transient interactive panel (e.g. Project Wizard / HTML wizard). */
  showPanel: (
    html: string,
    onAction?: (action: string, panel: HTMLElement) => void,
    onDestroy?: () => void,
  ) => void;
  /** Remove the current transient panel (if any) and run its cleanup. */
  clearPanel: () => void;
  /** Advise tab: update the sync-status badge (e.g. "문서 동기화됨 · 14:32"). */
  setAdviceSync: (label: string) => void;
  /** Reflect whether a single assistant response is being generated. */
  setStreaming: (streaming: boolean) => void;
  /** Discard the payload captured for the active request after successful completion. */
  completeRequest: () => void;
  /** Restore the payload captured for the active request after terminal failure. */
  failRequest: () => void;
  /** Add a pending image attachment to the composer (paste/file/programmatic). */
  addAttachment: (att: ChatAttachment) => void;
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

/** Sliders/settings glyph for the inline style toggle (no emoji). */
const STYLE_GEAR_ICON =
  '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><line x1="2" y1="4.5" x2="14" y2="4.5"/><circle cx="6" cy="4.5" r="1.6" fill="currentColor" stroke="none"/><line x1="2" y1="11.5" x2="14" y2="11.5"/><circle cx="10.5" cy="11.5" r="1.6" fill="currentColor" stroke="none"/></svg>';

export function renderUnifiedChat(): string {
  return `<div class="uc-root">
  <div class="uc-modes" role="tablist">
    <button class="uc-mode" data-mode="write" aria-selected="true" id="uc-tab-write" role="tab" aria-controls="uc-panel" tabindex="0" type="button">${t('uc.write')}</button>
    <button class="uc-mode" data-mode="advise" aria-selected="false" id="uc-tab-advise" role="tab" aria-controls="uc-panel" tabindex="-1" type="button">${t('uc.advise')}</button>
    <button class="uc-mode" data-mode="project" aria-selected="false" id="uc-tab-project" role="tab" aria-controls="uc-panel" tabindex="-1" type="button">${t('uc.project')}</button>
    <button class="uc-mode" data-mode="html" aria-selected="false" id="uc-tab-html" role="tab" aria-controls="uc-panel" tabindex="-1" type="button">${t('he.button')}</button>
    <button class="uc-style-toggle" type="button" hidden data-tooltip="${t('style.title')}" aria-label="${t('style.title')}" aria-expanded="false">${STYLE_GEAR_ICON}</button>
  </div>
  <div class="uc-style-panel" hidden></div>
  <div class="uc-panel" id="uc-panel" role="tabpanel" aria-labelledby="uc-tab-write">
    <div class="uc-thread" role="log"></div>
    <div class="uc-write-help" hidden>${t('uc.writeHelp')}</div>
    <div class="uc-advise-bar" hidden>
      <span class="uc-advise-status"></span>
      <button class="uc-advise-resync" type="button">${t('uc.advise.resync')}</button>
    </div>
    <div class="uc-chips" hidden></div>
    <div class="uc-tool-notice" hidden aria-live="polite"></div>
    <div class="uc-composer">
      <button class="uc-attach" type="button" data-tooltip="${t('uc.attach')}" aria-label="${t('uc.attach')}">+</button>
      <input class="uc-file" type="file" accept="image/png,image/jpeg,image/webp,.txt,.md,.markdown,.mdx,.csv,.tsv,.json,.yaml,.yml,.xml,.html,.css,.log,.pdf,.docx,.xlsx,.xls,.hwp,.hwpx,text/*" multiple hidden />
      <textarea class="uc-input" rows="2" placeholder="${t('uc.placeholder')}" aria-label="${t('uc.write')}"></textarea>
      <button class="uc-send" type="button">${t('uc.send')}</button>
    </div>
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
  const writeHelp = parent.querySelector<HTMLElement>('.uc-write-help')!;
  const adviseBar = parent.querySelector<HTMLElement>('.uc-advise-bar')!;
  const toolNotice = parent.querySelector<HTMLElement>('.uc-tool-notice')!;
  const composer = parent.querySelector<HTMLElement>('.uc-composer')!;
  const panel = parent.querySelector<HTMLElement>('.uc-panel')!;
  const sendButton = parent.querySelector<HTMLButtonElement>('.uc-send')!;
  let sending = false;
  const adviseStatus = parent.querySelector<HTMLElement>('.uc-advise-status')!;
  let mode: ChatMode = 'write';
  let toolActivation = 0;
  const chips = parent.querySelector<HTMLElement>('.uc-chips')!;
  const fileInput = parent.querySelector<HTMLInputElement>('.uc-file')!;
  type PendingItem = { kind: 'image'; img: ChatAttachment } | { kind: 'text'; txt: ChatTextAttachment };
  const pending: PendingItem[] = [];
  let activeRequest: { text: string; pending: PendingItem[] } | null = null;
  const MAX_ATTACHMENTS = 6;
  const MAX_IMAGES = 4;
  const imageCount = () => pending.reduce((n, p) => n + (p.kind === 'image' ? 1 : 0), 0);
  const activeImageCount = () =>
    activeRequest?.pending.reduce((n, p) => n + (p.kind === 'image' ? 1 : 0), 0) ?? 0;
  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  function renderChips() {
    chips.hidden = pending.length === 0;
    chips.innerHTML = pending
      .map((p, i) => {
        const name = p.kind === 'image' ? p.img.name ?? 'image' : p.txt.name;
        const icon = p.kind === 'image' ? '🖼' : '📄';
        return `<span class="uc-chip">${icon} ${esc(name)}<button class="uc-chip-x" data-chip="${i}" type="button" aria-label="remove">×</button></span>`;
      })
      .join('');
  }

  function addAttachment(att: ChatAttachment) {
    if (imageCount() + activeImageCount() >= MAX_IMAGES || pending.length + (activeRequest?.pending.length ?? 0) >= MAX_ATTACHMENTS) return;
    pending.push({ kind: 'image', img: att });
    renderChips();
  }

  function addTextFile(txt: ChatTextAttachment) {
    if (pending.length + (activeRequest?.pending.length ?? 0) >= MAX_ATTACHMENTS) return;
    pending.push({ kind: 'text', txt });
    renderChips();
  }

  async function fileToBase64(file: File): Promise<string> {
    const view = new Uint8Array(await file.arrayBuffer());
    let bin = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < view.length; i += CHUNK) {
      bin += String.fromCharCode(...view.subarray(i, i + CHUNK));
    }
    return btoa(bin);
  }

  async function readFiles(files: FileList | File[]) {
    for (const file of Array.from(files)) {
      if (pending.length >= MAX_ATTACHMENTS) break;
      const ext = (file.name.split('.').pop() ?? '').toLowerCase();
      if (/^image\/(png|jpeg|webp)$/.test(file.type)) {
        if (imageCount() >= MAX_IMAGES) continue;
        addAttachment({ mime: file.type, base64: await fileToBase64(file), bytes: file.size, name: file.name });
      } else if (CONVERTIBLE_EXT_SET.has(ext) && handlers.convertFile) {
        // PDF / DOCX / XLSX / HWP → convert to Markdown text in the main process.
        const r = await handlers.convertFile(await fileToBase64(file), ext, file.name).catch(() => ({ ok: false }));
        if ((r as { ok: boolean }).ok && (r as { markdown?: string }).markdown) {
          addTextFile({ name: file.name, text: (r as { markdown: string }).markdown.slice(0, MAX_TEXT_FILE_CHARS), bytes: file.size });
        }
      } else if (TEXT_READABLE_EXTS.has(ext) || /^text\//.test(file.type) || file.type === 'application/json') {
        const text = await file.text();
        if (text.trim()) addTextFile({ name: file.name, text: text.slice(0, MAX_TEXT_FILE_CHARS), bytes: file.size });
      }
      // Unsupported binary types are silently skipped.
    }
  }

  /** Write help shows only on an empty Write thread; the advise bar only on Advise. */
  function updateChrome() {
    const empty = !thread.querySelector('.uc-msg') && !thread.querySelector('.uc-separator');
    const toolMode = mode === 'project' || mode === 'html';
    writeHelp.hidden = !(mode === 'write' && empty);
    adviseBar.hidden = mode !== 'advise';
    composer.hidden = toolMode;
    toolNotice.hidden = !toolMode;
    if (toolMode) toolNotice.textContent = t(mode === 'project' ? 'uc.tool.project' : 'uc.tool.html');
  }

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

  function setStreaming(streaming: boolean) {
    sending = streaming;
    sendButton.disabled = streaming;
    sendButton.textContent = t(streaming ? 'uc.generating' : 'uc.send');
    composer.classList.toggle('uc-composer-streaming', streaming);
  }

  function addMessage(role: 'user' | 'assistant', text: string) {
    const node = newBubble(role);
    node.dataset.text = text;
    // Assistant content is rich markdown; user messages stay plain text.
    renderBody(node, text, role === 'assistant');
    thread.appendChild(node);
    scrollToEnd();
    updateChrome();
  }

  function beginAssistant(): AssistantStream {
    const node = newBubble('assistant');
    const actions = node.querySelector<HTMLElement>('.uc-actions');
    if (actions) actions.style.display = 'none';
    node.classList.add('uc-streaming');
    thread.appendChild(node);
    scrollToEnd();
    updateChrome();
    let buffer = '';
    return {
      pushDelta(text: string) {
        buffer += text;
        renderBody(node, buffer, true);
        scrollToEnd();
      },
      finalize(finalText?: string) {
        buffer = (finalText && finalText.trim() ? finalText : buffer).trim();
        node.dataset.text = buffer;
        renderBody(node, buffer, true);
        node.classList.remove('uc-streaming');
        if (actions) actions.style.display = '';
        scrollToEnd();
        return buffer;
      },
      fail(message: string) {
        node.classList.remove('uc-streaming');
        const body = node.querySelector<HTMLElement>('.uc-body')!;
        if (buffer.trim()) {
          // Preserve whatever streamed in before the error — the user can still
          // read/copy the partial answer. Append the error as a separate note
          // rather than overwriting the content (which silently lost it).
          node.dataset.text = buffer.trim();
          renderBody(node, buffer, true);
          const note = document.createElement('div');
          note.className = 'uc-err';
          note.textContent = `⚠ ${t('uc.error.retry')} ${message}`;
          body.appendChild(note);
          if (actions) actions.style.display = '';
        } else {
          body.textContent = `⚠ ${t('uc.error.retry')} ${message}`;
          body.classList.add('uc-err');
        }
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
    updateChrome();
  }

  let panelDestroy: (() => void) | null = null;

  function clearPanel() {
    for (const existing of Array.from(thread.querySelectorAll('.uc-panel-msg'))) existing.remove();
    if (panelDestroy) {
      const d = panelDestroy;
      panelDestroy = null;
      d();
    }
    updateChrome();
  }

  function showPanel(
    html: string,
    onAction?: (action: string, panel: HTMLElement) => void,
    onDestroy?: () => void,
  ) {
    // Only one transient panel at a time (e.g. Project Wizard / HTML wizard).
    clearPanel();
    panelDestroy = onDestroy ?? null;
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
    updateChrome();
  }

  // ----- inline style settings (difficulty + naturalness) -----
  const styleToggle = parent.querySelector<HTMLButtonElement>('.uc-style-toggle')!;
  const stylePanel = parent.querySelector<HTMLElement>('.uc-style-panel')!;
  let styleHandle: StyleSettingHandle | null = null;
  if (handlers.style) styleToggle.hidden = false;
  const toggleStylePanel = () => {
    if (!handlers.style) return;
    const show = stylePanel.hidden;
    if (show) {
      // Re-mount on each open so it reflects the latest setting (Block AI shares it).
      styleHandle?.destroy();
      styleHandle = mountStyleSettingPanel(stylePanel, {
        setting: handlers.style.get(),
        onChange: (s) => handlers.style!.onChange(s),
      });
    }
    stylePanel.hidden = !show;
    styleToggle.setAttribute('aria-expanded', String(show));
  };

  const activateMode = (btn: HTMLButtonElement) => {
    const previousMode = mode;
    mode = (btn.dataset.mode as ChatMode) ?? 'write';
    const activation = ++toolActivation;
    const guard: ToolPanelGuard = {
      isCurrent: () => toolActivation === activation && mode === (btn.dataset.mode as ChatMode),
    };
    for (const tab of parent.querySelectorAll<HTMLButtonElement>('.uc-mode')) {
      const active = tab === btn;
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
    }
    panel.setAttribute('aria-labelledby', btn.id);
    const enteringTool = mode === 'project' || mode === 'html';
    const leavingTool = previousMode === 'project' || previousMode === 'html';
    if (!enteringTool || leavingTool) clearPanel();
    handlers.onModeChange?.(mode);
    if (mode === 'project') handlers.onProjectSetup?.(guard);
    else if (mode === 'html') handlers.onHtmlExport?.(guard);
    updateChrome();
  };

  const onModeClick = (e: Event) => {
    if ((e.target as HTMLElement).closest('.uc-style-toggle')) {
      toggleStylePanel();
      return;
    }
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('.uc-mode');
    if (btn) activateMode(btn);
  };

  const onModeKeydown = (e: KeyboardEvent) => {
    const tabs = Array.from(parent.querySelectorAll<HTMLButtonElement>('.uc-mode'));
    const current = (e.target as HTMLElement).closest<HTMLButtonElement>('.uc-mode');
    if (!current) return;
    const currentIndex = tabs.indexOf(current);
    if (currentIndex < 0) return;

    let nextIndex: number | null = null;
    if (e.key === 'ArrowRight') nextIndex = (currentIndex + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') nextIndex = 0;
    else if (e.key === 'End') nextIndex = tabs.length - 1;
    if (nextIndex === null) return;

    e.preventDefault();
    const next = tabs[nextIndex];
    next.focus();
    activateMode(next);
  };

  const onAdviseResync = (e: Event) => {
    if ((e.target as HTMLElement).closest('.uc-advise-resync')) handlers.onAdviceResync?.();
  };

  const send = () => {
    // Project/HTML are panel-driven tabs with no composer turn — never send or
    // wipe the user's text from them (would be silent text loss).
    if (sending || mode === 'project' || mode === 'html') return;
    const text = input.value.trim();
    const request = { text, pending: [...pending] };
    const images = request.pending
      .filter((p): p is { kind: 'image'; img: ChatAttachment } => p.kind === 'image')
      .map((p) => p.img);
    const textFiles = request.pending
      .filter((p): p is { kind: 'text'; txt: ChatTextAttachment } => p.kind === 'text')
      .map((p) => p.txt);
    // Allow an attachment-only turn (e.g. "OCR this" / "summarize this file").
    if (!text && request.pending.length === 0) return;
    activeRequest = request;
    setStreaming(true);
    input.value = '';
    pending.length = 0;
    renderChips();
    handlers.onSend(text, mode, images.length ? images : undefined, textFiles.length ? textFiles : undefined);
  };

  const onComposerExtraClick = (e: Event) => {
    const target = e.target as HTMLElement;
    if (target.closest('.uc-attach')) {
      fileInput.click();
      return;
    }
    const chipX = target.closest<HTMLElement>('.uc-chip-x');
    if (chipX) {
      const i = Number(chipX.dataset.chip);
      if (Number.isInteger(i)) {
        pending.splice(i, 1);
        renderChips();
      }
    }
  };

  const onPaste = (e: ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const files: File[] = [];
    for (const it of Array.from(items)) {
      if (it.kind === 'file' && /^image\//.test(it.type)) {
        const f = it.getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length) {
      e.preventDefault();
      void readFiles(files);
    }
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

  const modes = parent.querySelector<HTMLElement>('.uc-modes')!;
  modes.addEventListener('click', onModeClick);
  modes.addEventListener('keydown', onModeKeydown);
  parent.querySelector('.uc-composer')!.addEventListener('click', onComposerClick);
  parent.querySelector('.uc-composer')!.addEventListener('click', onComposerExtraClick);
  chips.addEventListener('click', onComposerExtraClick);
  fileInput.addEventListener('change', () => {
    if (fileInput.files) void readFiles(fileInput.files).then(() => (fileInput.value = ''));
  });
  input.addEventListener('paste', onPaste);
  parent.querySelector('.uc-advise-bar')!.addEventListener('click', onAdviseResync);
  input.addEventListener('keydown', onKeydown);
  thread.addEventListener('click', onThreadClick);
  updateChrome();

  return {
    addMessage,
    beginAssistant,
    getMode: () => mode,
    restore: (snap) => renderItems(restoreUnifiedThread(snap)),
    clear: () => {
      thread.innerHTML = '';
      updateChrome();
    },
    setAdviceSync: (label: string) => {
      adviseStatus.textContent = label;
    },
    setStreaming,
    completeRequest: () => {
      activeRequest = null;
      setStreaming(false);
    },
    failRequest: () => {
      const request = activeRequest;
      activeRequest = null;
      setStreaming(false);
      if (!request) return;
      const draft = input.value;
      input.value = request.text && draft ? `${request.text}\n\n${draft}` : request.text || draft;
      pending.unshift(...request.pending);
      renderChips();
    },
    addAttachment,
    showPanel,
    clearPanel,
    destroy: () => {
      clearPanel();
      styleHandle?.destroy();
      parent.innerHTML = '';
    },
  };
}
