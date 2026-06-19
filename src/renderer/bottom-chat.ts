import MarkdownIt from 'markdown-it';
// @ts-expect-error — no types
import taskLists from 'markdown-it-task-lists';
import { t } from './i18n';
import { openMenu } from './dropdown';
import { QUALITY_ORDER, qualityDirective, qualityLabel, type Quality } from './quality';

/**
 * Bottom drawer chat panel (F5).
 * - Collapsible drawer anchored to the bottom-right corner.
 * - User input: Enter sends, Shift+Enter inserts newline, Esc cancels stream.
 * - Assistant output rendered as Markdown (rich view) for readability.
 */

type ChatTurn = { role: 'user' | 'assistant'; text: string };

export type ChatHandlers = {
  getDocument: () => string;
  setDocument: (md: string) => void;
  insertAtCursor: (md: string) => void;
  onStatus: (msg: string) => void;
  getModel: () => string | undefined;
  getQuality: () => Quality;
  onQualityChange: (q: Quality) => void;
  getHistory?: () => ChatTurn[];
  onHistoryChange?: (history: ChatTurn[]) => void;
};

const SYSTEM_PROMPT = `You are a writing assistant inside a Mac markdown editor.
The user wants concise, well-structured Markdown drafts and rewrites.

Rules:
- Reply ONLY with the final markdown content unless the user is asking a question.
- Do not wrap output in code fences.
- Preserve existing structure (headings, lists, tables) when rewriting.
- Match the user's language (Korean or English) — if they wrote Korean, reply in Korean.`;

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

type AssistantBubble = {
  el: HTMLDivElement;
  bodyEl: HTMLDivElement;
  actionsEl: HTMLDivElement;
  buffer: string;
  id: string;
};

export function mountBottomChat(parent: HTMLElement, handlers: ChatHandlers) {
  parent.innerHTML = `
    <button class="bc-toggle" id="bc-toggle" data-tooltip="${t('chat.open')}" aria-label="${t('chat.open')}">
      <span class="bc-toggle-label">AI</span>
    </button>
    <div class="bc-drawer" id="bc-drawer" role="dialog" aria-label="${t('chat.title')}">
      <div class="bc-head">
        <div class="bc-title">${t('chat.title')}</div>
        <div class="bc-head-actions">
          <button class="bc-iconbtn" id="bc-clear" data-tooltip="${t('chat.clear')}">${t('chat.clear')}</button>
          <button class="bc-iconbtn bc-close" id="bc-close" data-tooltip="${t('chat.hide')}" aria-label="${t('chat.hide')}">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><line x1="2.5" y1="2.5" x2="9.5" y2="9.5"/><line x1="9.5" y1="2.5" x2="2.5" y2="9.5"/></svg>
          </button>
        </div>
      </div>
      <div class="bc-thread" id="bc-thread"></div>
      <div class="bc-presets" id="bc-presets">
        <button data-preset="draft">${t('chat.preset.draft')}</button>
        <button data-preset="rewrite">${t('chat.preset.rewrite')}</button>
        <button data-preset="summary">${t('chat.preset.summary')}</button>
        <button data-preset="proof">${t('chat.preset.proof')}</button>
      </div>
      <div class="bc-composer">
        <button class="bc-quality" id="bc-quality" data-tooltip="${t('tip.quality')}" aria-label="${t('tip.quality')}">
          <span class="bc-quality-label">${t('quality.label')}</span>
          <span class="bc-quality-value">${qualityLabel(handlers.getQuality())}</span>
        </button>
        <textarea id="bc-input" placeholder="${t('chat.placeholder')}" rows="2"></textarea>
        <button class="bc-send" id="bc-send" data-tooltip="Send (Enter)" aria-label="Send">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="13" x2="8" y2="3"/><polyline points="3.5,7.5 8,3 12.5,7.5"/></svg>
        </button>
      </div>
    </div>
  `;

  const toggle = parent.querySelector<HTMLButtonElement>('#bc-toggle')!;
  const drawer = parent.querySelector<HTMLDivElement>('#bc-drawer')!;
  const closeBtn = parent.querySelector<HTMLButtonElement>('#bc-close')!;
  const clearBtn = parent.querySelector<HTMLButtonElement>('#bc-clear')!;
  const thread = parent.querySelector<HTMLDivElement>('#bc-thread')!;
  const input = parent.querySelector<HTMLTextAreaElement>('#bc-input')!;
  const sendBtn = parent.querySelector<HTMLButtonElement>('#bc-send')!;
  const presets = parent.querySelector<HTMLDivElement>('#bc-presets')!;
  const qualityBtn = parent.querySelector<HTMLButtonElement>('#bc-quality')!;
  const qualityValueEl = qualityBtn.querySelector<HTMLSpanElement>('.bc-quality-value')!;
  qualityBtn.addEventListener('click', () => {
    const cur = handlers.getQuality();
    openMenu<Quality>({
      anchor: qualityBtn,
      items: QUALITY_ORDER.map((q) => ({ value: q, label: qualityLabel(q), selected: q === cur })),
      onSelect: (v) => {
        handlers.onQualityChange(v);
        qualityValueEl.textContent = qualityLabel(v);
      },
      minWidth: 180,
    });
  });

  let open = false;
  let history: ChatTurn[] = handlers.getHistory?.() ?? [];
  let inflight: { id: string; cleanup: () => void } | null = null;

  function appendUserBubble(text: string): void {
    const div = document.createElement('div');
    div.className = 'bc-msg bc-user';
    div.textContent = text;
    thread.appendChild(div);
    thread.scrollTop = thread.scrollHeight;
  }

  function startAssistantBubble(): AssistantBubble {
    const div = document.createElement('div');
    div.className = 'bc-msg bc-assist';
    div.innerHTML = `
      <div class="bc-body bc-markdown"></div>
      <div class="bc-actions" style="display:none;">
        <button data-act="insert">${t('chat.action.insert')}</button>
        <button data-act="replace">${t('chat.action.replace')}</button>
        <button data-act="copy">${t('chat.action.copy')}</button>
        <button data-act="discard">${t('chat.action.discard')}</button>
      </div>
      <div class="bc-stream-indicator">
        <span class="dot"></span><span class="dot"></span><span class="dot"></span>
      </div>
    `;
    thread.appendChild(div);
    thread.scrollTop = thread.scrollHeight;
    return {
      el: div,
      bodyEl: div.querySelector('.bc-body') as HTMLDivElement,
      actionsEl: div.querySelector('.bc-actions') as HTMLDivElement,
      buffer: '',
      id: cryptoId(),
    };
  }

  function renderAssistantBody(bubble: AssistantBubble) {
    // Render in-flight buffer as markdown — gives rich view while streaming.
    bubble.bodyEl.innerHTML = md.render(bubble.buffer);
  }

  function attachActions(bubble: AssistantBubble) {
    const ind = bubble.el.querySelector('.bc-stream-indicator') as HTMLElement | null;
    ind?.remove();
    bubble.actionsEl.style.display = 'flex';
    bubble.actionsEl.querySelectorAll<HTMLButtonElement>('button').forEach((btn) => {
      btn.addEventListener('click', () => {
        const act = btn.dataset.act!;
        const text = bubble.buffer.trim();
        if (act === 'insert') handlers.insertAtCursor('\n' + text + '\n');
        else if (act === 'replace') handlers.setDocument(text);
        else if (act === 'copy') void navigator.clipboard.writeText(text);
        else if (act === 'discard') bubble.el.remove();
        if (act !== 'discard') handlers.onStatus(`Applied: ${act}`);
      });
    });
  }

  // Replay previously stored history into the thread.
  if (history.length) {
    for (const t of history) {
      if (t.role === 'user') appendUserBubble(t.text);
      else {
        const b = startAssistantBubble();
        b.buffer = t.text;
        renderAssistantBody(b);
        attachActions(b);
      }
    }
  }

  function setOpen(v: boolean) {
    open = v;
    drawer.classList.toggle('open', v);
    toggle.classList.toggle('hidden', v);
    if (v) setTimeout(() => input.focus(), 50);
  }

  toggle.addEventListener('click', () => setOpen(true));
  closeBtn.addEventListener('click', () => setOpen(false));
  clearBtn.addEventListener('click', () => {
    history = [];
    handlers.onHistoryChange?.(history);
    thread.innerHTML = '';
  });

  async function send(userText: string) {
    if (!userText.trim()) return;
    appendUserBubble(userText);
    input.value = '';
    input.style.height = '';
    history.push({ role: 'user', text: userText });

    const bubble = startAssistantBubble();
    const qd = qualityDirective(handlers.getQuality());
    const instructions =
      `${SYSTEM_PROMPT}\n\n${qd}\n\n=== Current document ===\n${handlers.getDocument().slice(0, 12000) || '(empty)'}\n=== End document ===`;

    sendBtn.disabled = true;
    sendBtn.classList.add('streaming');
    const cleanup = window.api.onAiChatEvent(bubble.id, (e) => {
      if (e.kind === 'delta' && e.text) {
        bubble.buffer += e.text;
        renderAssistantBody(bubble);
        thread.scrollTop = thread.scrollHeight;
      } else if (e.kind === 'done') {
        const final = (e.text || bubble.buffer).trim();
        bubble.buffer = final;
        renderAssistantBody(bubble);
        history.push({ role: 'assistant', text: final });
        handlers.onHistoryChange?.(history);
        attachActions(bubble);
        sendBtn.disabled = false;
        sendBtn.classList.remove('streaming');
        cleanup();
        inflight = null;
      } else if (e.kind === 'error') {
        bubble.bodyEl.textContent = `⚠ ${e.message}`;
        bubble.bodyEl.classList.add('bc-err');
        (bubble.el.querySelector('.bc-stream-indicator') as HTMLElement | null)?.remove();
        sendBtn.disabled = false;
        sendBtn.classList.remove('streaming');
        cleanup();
        inflight = null;
      }
    });
    inflight = { id: bubble.id, cleanup };

    try {
      await window.api.aiChat(bubble.id, instructions, history.slice(0, -1), userText, handlers.getModel());
    } catch (e: any) {
      bubble.bodyEl.textContent = `⚠ ${e?.message ?? e}`;
      bubble.bodyEl.classList.add('bc-err');
      sendBtn.disabled = false;
      sendBtn.classList.remove('streaming');
      cleanup();
      inflight = null;
    }
  }

  sendBtn.addEventListener('click', () => send(input.value));

  // Auto-grow textarea up to max-height
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(120, input.scrollHeight) + 'px';
  });

  input.addEventListener('keydown', (e) => {
    // Korean/CJK IME composition guard — Enter during composition
    // must commit the IME, never fire send. keyCode 229 is the
    // Chromium fallback when isComposing isn't propagated.
    if (e.isComposing || (e as any).keyCode === 229) return;
    if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      void send(input.value);
      return;
    }
    if (e.key === 'Escape' && inflight) {
      void window.api.aiCancel(inflight.id);
    }
  });

  presets.querySelectorAll<HTMLButtonElement>('button[data-preset]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const preset = btn.dataset.preset!;
      let prompt = '';
      switch (preset) {
        case 'draft': {
          const topic = window.prompt(t('chat.draftPrompt'), '') ?? '';
          prompt = `Write a clean Markdown draft on this topic: ${topic}`;
          break;
        }
        case 'rewrite':
          prompt = 'Rewrite the entire current document in a clearer, more formal tone. Preserve headings, lists, and tables.';
          break;
        case 'summary':
          prompt = 'Summarize the current document as 5 or fewer concise bullet points.';
          break;
        case 'proof':
          prompt = 'Proofread the current document — correct spelling and grammar, smooth awkward phrasing, keep the meaning.';
          break;
      }
      if (prompt) {
        input.value = prompt;
        input.focus();
      }
    });
  });

  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === ';') {
      e.preventDefault();
      setOpen(!open);
    }
  });
}

function cryptoId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}
