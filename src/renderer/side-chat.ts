import MarkdownIt from 'markdown-it';
// @ts-expect-error — no types
import taskLists from 'markdown-it-task-lists';
import { t } from './i18n';
import { openMenu } from './dropdown';
import { QUALITY_ORDER, qualityDirective, qualityLabel, type Quality } from './quality';

/**
 * Side chat (F4) — a slide-in right panel for *consultation*.
 * Differs from the bottom chat (F5):
 *   - No Apply / Replace buttons. The AI never writes back to the doc here.
 *   - System prompt is conversational: asks questions, offers opinions,
 *     surfaces gaps, suggests directions.
 *   - Independent conversation history (separate from bottom chat).
 *   - Slides in from the right edge, ~400px wide.
 */

type ChatTurn = { role: 'user' | 'assistant'; text: string };

export type SideChatHandlers = {
  getDocument: () => string;
  onStatus: (msg: string) => void;
  getModel: () => string | undefined;
  getQuality: () => Quality;
  onQualityChange: (q: Quality) => void;
  getHistory?: () => ChatTurn[];
  onHistoryChange?: (history: ChatTurn[]) => void;
  onStartProjectWizard?: () => void;
};

function systemPrompt(): string {
  return `You are an editorial consultant embedded in a Markdown editor.
The user is writing a document and is asking for your thoughts, not for rewritten content.

Style:
- Be conversational and concise. Ask clarifying questions when useful.
- Offer perspective: structural feedback, missing pieces, tone, audience fit.
- Avoid producing full drafts unless explicitly asked; suggest *moves* instead.
- Match the user's language (Korean or English).
- Render answers in clean Markdown (headings/bullets allowed, no code fences around the whole reply).`;
}

const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
  typographer: true,
}).use(taskLists, { enabled: true });

const defaultLinkOpen =
  md.renderer.rules.link_open ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  if (tokens[idx].attrIndex('target') < 0) tokens[idx].attrPush(['target', '_blank']);
  tokens[idx].attrSet('rel', 'noopener noreferrer');
  return defaultLinkOpen(tokens, idx, options, env, self);
};

type AssistantBubble = {
  el: HTMLDivElement;
  bodyEl: HTMLDivElement;
  buffer: string;
  id: string;
};

export type SideChatHandle = {
  toggle: () => void;
  open: () => void;
  close: () => void;
  isOpen: () => boolean;
  showProjectWizardPanel: (
    html: string,
    onAction?: (action: string, panel: HTMLElement) => void,
  ) => void;
  renderShell: () => void;
};

export function mountSideChat(parent: HTMLElement, handlers: SideChatHandlers): SideChatHandle {
  let history: ChatTurn[] = handlers.getHistory?.() ?? [];
  let inflight: { id: string; cleanup: () => void } | null = null;
  let open = false;

  function renderShell() {
    parent.innerHTML = `
      <div class="sc-panel" id="sc-panel" role="complementary" aria-label="${t('sc.title')}">
        <div class="sc-head">
          <div class="sc-title">${t('sc.title')}</div>
          <div class="sc-head-actions">
            <button class="sc-iconbtn" id="sc-project-wizard" type="button" aria-label="Project setup" data-tooltip="Project setup">Setup</button>
            <button class="sc-iconbtn" id="sc-clear" data-tooltip="${t('chat.clear')}">${t('chat.clear')}</button>
            <button class="sc-iconbtn sc-close" id="sc-close" data-tooltip="${t('chat.hide')}" aria-label="${t('chat.hide')}">
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><line x1="2.5" y1="2.5" x2="9.5" y2="9.5"/><line x1="9.5" y1="2.5" x2="2.5" y2="9.5"/></svg>
            </button>
          </div>
        </div>
        <div class="sc-thread" id="sc-thread"></div>
        <div class="sc-composer">
          <button class="bc-quality" id="sc-quality" data-tooltip="${t('tip.quality')}" aria-label="${t('tip.quality')}">
            <span class="bc-quality-label">${t('quality.label')}</span>
            <span class="bc-quality-value">${qualityLabel(handlers.getQuality())}</span>
          </button>
          <textarea id="sc-input" placeholder="${t('sc.placeholder')}" rows="2"></textarea>
          <button class="sc-send" id="sc-send" data-tooltip="Send (Enter)" aria-label="Send">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="13" x2="8" y2="3"/><polyline points="3.5,7.5 8,3 12.5,7.5"/></svg>
          </button>
        </div>
      </div>
    `;
    wire();
    // Replay history
    for (const turn of history) {
      if (turn.role === 'user') appendUserBubble(turn.text);
      else {
        const b = startAssistantBubble();
        b.buffer = turn.text;
        renderAssistantBody(b);
      }
    }
  }

  let panel!: HTMLDivElement;
  let thread!: HTMLDivElement;
  let input!: HTMLTextAreaElement;
  let sendBtn!: HTMLButtonElement;

  function wire() {
    panel = parent.querySelector('#sc-panel') as HTMLDivElement;
    thread = parent.querySelector('#sc-thread') as HTMLDivElement;
    input = parent.querySelector('#sc-input') as HTMLTextAreaElement;
    sendBtn = parent.querySelector('#sc-send') as HTMLButtonElement;
    const closeBtn = parent.querySelector('#sc-close') as HTMLButtonElement;
    const clearBtn = parent.querySelector('#sc-clear') as HTMLButtonElement;
    const wizardBtn = parent.querySelector('#sc-project-wizard') as HTMLButtonElement | null;

    if (open) panel.classList.add('open');

    wizardBtn?.addEventListener('click', () => handlers.onStartProjectWizard?.());
    closeBtn.addEventListener('click', () => api.close());
    clearBtn.addEventListener('click', () => {
      history = [];
      handlers.onHistoryChange?.(history);
      thread.innerHTML = '';
    });

    sendBtn.addEventListener('click', () => send(input.value));

    const qualityBtn = parent.querySelector<HTMLButtonElement>('#sc-quality')!;
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
    input.addEventListener('input', () => {
      input.style.height = 'auto';
      input.style.height = Math.min(140, input.scrollHeight) + 'px';
    });
    input.addEventListener('keydown', (e) => {
      // IME composition guard for CJK input
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
  }

  function appendUserBubble(text: string) {
    const div = document.createElement('div');
    div.className = 'sc-msg sc-user';
    div.textContent = text;
    thread.appendChild(div);
    thread.scrollTop = thread.scrollHeight;
  }

  function appendProjectWizardPanel(html: string, onAction?: (action: string, panel: HTMLElement) => void) {
    for (const existing of Array.from(thread.querySelectorAll('.sc-project-wizard-msg'))) {
      existing.remove();
    }
    const div = document.createElement('div');
    div.className = 'sc-msg sc-assist sc-project-wizard-msg';
    div.innerHTML = html;
    div.addEventListener('click', (event) => {
      const target = event.target as HTMLElement | null;
      const actionEl = target?.closest<HTMLElement>('[data-pw-action]');
      if (!actionEl || !div.contains(actionEl)) return;
      onAction?.(actionEl.dataset.pwAction ?? '', div);
    });
    thread.appendChild(div);
    thread.scrollTop = thread.scrollHeight;
  }

  function startAssistantBubble(): AssistantBubble {
    const div = document.createElement('div');
    div.className = 'sc-msg sc-assist';
    div.innerHTML = `
      <div class="sc-body sc-markdown"></div>
      <div class="sc-stream-indicator">
        <span class="dot"></span><span class="dot"></span><span class="dot"></span>
      </div>
    `;
    thread.appendChild(div);
    thread.scrollTop = thread.scrollHeight;
    return {
      el: div,
      bodyEl: div.querySelector('.sc-body') as HTMLDivElement,
      buffer: '',
      id: 'sc-' + Math.random().toString(36).slice(2) + Date.now().toString(36),
    };
  }

  function renderAssistantBody(b: AssistantBubble) {
    b.bodyEl.innerHTML = md.render(b.buffer);
  }

  function finalize(b: AssistantBubble) {
    (b.el.querySelector('.sc-stream-indicator') as HTMLElement | null)?.remove();
  }

  async function send(userText: string) {
    if (!userText.trim()) return;
    appendUserBubble(userText);
    input.value = '';
    input.style.height = '';
    history.push({ role: 'user', text: userText });

    const bubble = startAssistantBubble();
    const qd = qualityDirective(handlers.getQuality());
    const instructions =
      `${systemPrompt()}\n\n${qd}\n\n=== Current document ===\n${handlers.getDocument().slice(0, 12000) || '(empty)'}\n=== End document ===`;

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
        finalize(bubble);
        sendBtn.disabled = false;
        sendBtn.classList.remove('streaming');
        cleanup();
        inflight = null;
      } else if (e.kind === 'error') {
        bubble.bodyEl.textContent = `⚠ ${e.message}`;
        bubble.bodyEl.classList.add('sc-err');
        finalize(bubble);
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
      bubble.bodyEl.classList.add('sc-err');
      sendBtn.disabled = false;
      sendBtn.classList.remove('streaming');
      cleanup();
      inflight = null;
    }
  }

  const api: SideChatHandle = {
    isOpen: () => open,
    open: () => {
      open = true;
      panel.classList.add('open');
      document.body.classList.add('sc-open');
      setTimeout(() => input?.focus(), 100);
    },
    close: () => {
      open = false;
      panel.classList.remove('open');
      document.body.classList.remove('sc-open');
    },
    toggle: () => (open ? api.close() : api.open()),
    showProjectWizardPanel: appendProjectWizardPanel,
    renderShell,
  };

  renderShell();
  return api;
}
