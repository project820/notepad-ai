import { EditorSelection } from '@codemirror/state';
import { mountHtmlExportWizard, type HtmlExportWizardHandle } from './html-export-wizard';
import { HTML_EXPORT_CONTENT_INSTRUCTIONS } from './html-export-content-prompt';
import { clampChatWidth } from './chat-layout';
import { guardVerdict } from './humanize-guards';
import { styleDirective, detectLanguage, type Naturalness } from './humanize-engine';
import { t } from './i18n';
import { modelContextWindowTokens } from '../main/ai/output-budget';
import { isAiProviderId, type AiProviderId } from '../main/ai/types';
import { openSettingsModal } from './settings-modal';
import { savePrefs, type Prefs } from './prefs';
import { buildUnifiedChatInstructions } from './unified-chat-prompt-handler';
import { threadToTurns, type UnifiedChatItem } from './unified-chat-history';
import {
  mountUnifiedChat,
  type ChatAttachment,
  type ChatMode,
  type ChatTextAttachment,
  type ToolPanelGuard,
  type UnifiedChatHandle,
} from './unified-chat';
import type { AppContext } from './app-context';
import type { AuthSnapshot } from '../shared/auth-protocol';
import type { Quality } from './quality';
import type { RendererModel } from './model-cache';

export type UnifiedChatWiring = {
  unifiedChat: UnifiedChatHandle;
  toggleUnifiedChat: () => void;
  setUnifiedChatOpen: (open: boolean) => void;
  cancelInflight: () => void;
  currentStyle: () => { difficulty: Quality; naturalness: Naturalness };
  openSettings: () => void;
  paintAuthPill: (auth: AuthSnapshot) => void;
  getHistory: () => UnifiedChatItem[];
  setHistory: (history: UnifiedChatItem[]) => void;
};

type UnifiedChatWiringDeps = {
  prefs: Prefs;
  loadModelsCached: (force?: boolean) => Promise<RendererModel[]>;
  invalidateModels: () => void;
  getAuth: () => AuthSnapshot;
  setAuth: (auth: AuthSnapshot) => void;
  paintAccountState: (signedIn: boolean) => void;
  scheduleSessionSnapshot: () => void;
  onSuppressedEditorChange: (doc: string, updatePreview: boolean) => void;
  onProjectSetup: (guard: ToolPanelGuard) => void;
};

export function initUnifiedChatWiring(ctx: AppContext, deps: UnifiedChatWiringDeps): UnifiedChatWiring {
  const unifiedChatHost = document.getElementById('unified-chat') as HTMLDivElement;
  const contentRow = document.querySelector('.content-row') as HTMLElement;
  const ucResizer = document.querySelector('.uc-resizer') as HTMLDivElement;
  let unifiedChatHistory: UnifiedChatItem[] = [];
  let ucOpen = false;
  let ucInflight: { id: string; cleanup: () => void } | null = null;
  let adviceSnapshot = '';
  let htmlExportWizard: HtmlExportWizardHandle | null = null;

  function applyAiOutput(action: 'replace' | 'insert', md: string) {
    if (action === 'replace') {
      ctx.suppressEditorChange = true;
      ctx.editor.setDoc(md);
      ctx.suppressEditorChange = false;
      deps.onSuppressedEditorChange(md, true);
    } else {
      const { state } = ctx.editor.view;
      const pos = state.selection.main.from;
      ctx.editor.view.dispatch({
        changes: { from: pos, insert: md },
        selection: EditorSelection.cursor(pos + md.length),
        scrollIntoView: true,
      });
    }
  }

  function ucId(): string {
    return 'uc-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

  function setUnifiedChatOpen(open: boolean) {
    ucOpen = open;
    contentRow.classList.toggle('uc-open', open);
    unifiedChatHost.hidden = !open;
    ucResizer.hidden = !open;
    if (open) setTimeout(() => unifiedChatHost.querySelector<HTMLTextAreaElement>('.uc-input')?.focus(), 60);
  }

  function toggleUnifiedChat() {
    setUnifiedChatOpen(!ucOpen);
  }

  function currentStyle(): { difficulty: Quality; naturalness: Naturalness } {
    return deps.prefs.style ?? { difficulty: deps.prefs.quality ?? 'college', naturalness: 'balanced' };
  }

  function currentModelArg(): string | { provider: AiProviderId; id: string } | undefined {
    return deps.prefs.selectedModel ?? deps.prefs.model;
  }

  function applyStyle(next: { difficulty: Quality; naturalness: Naturalness }) {
    deps.prefs.style = next;
    deps.prefs.quality = next.difficulty;
    savePrefs(deps.prefs);
    ctx.setStatus(t('status.style').replace('{difficulty}', next.difficulty).replace('{naturalness}', next.naturalness));
  }

  function paintAuthPill(auth: AuthSnapshot) {
    deps.setAuth(auth);
    deps.paintAccountState(auth.signedIn);
  }

  function openSettings() {
    openSettingsModal({
      onAfterAuthChange: () => {
        deps.invalidateModels();
        void deps.loadModelsCached(true);
        void (async () => {
          const auth = await window.api.authStatus();
          paintAuthPill(auth);
        })();
      },
      onSetCustomModel: (provider, modelId) => {
        deps.prefs.selectedModel = { provider, id: modelId };
        if (provider === 'chatgpt') deps.prefs.model = modelId;
        savePrefs(deps.prefs);
        ctx.setStatus(t('status.modelProvider').replace('{provider}', provider).replace('{model}', modelId));
      },
    });
  }

  async function sendUnified(
    text: string,
    mode: ChatMode,
    attachments?: ChatAttachment[],
    textFiles?: ChatTextAttachment[],
  ) {
    const hasAuth = await window.api.aiHasAnyAuth().catch(() => true);
    if (!hasAuth) {
      unifiedChat.addMessage('user', text);
      unifiedChatHistory.push({ type: 'message', role: 'user', text });
      deps.scheduleSessionSnapshot();
      unifiedChat.addMessage('assistant', t('chat.noProvider'));
      ctx.setStatus(t('status.connectProvider'));
      unifiedChat.failRequest();
      unifiedChat.setStreaming(false);
      openSettings();
      return;
    }
    const priorTurns = threadToTurns(unifiedChatHistory);
    const fileContext = (textFiles ?? [])
      .map((f) => `[Attached file: ${f.name}]\n"""\n${f.text}\n"""`)
      .join('\n\n');
    const aiText = fileContext ? `${text ? text + '\n\n' : ''}${fileContext}` : text;
    const attachLabels = [
      ...(attachments?.length ? [`${attachments.length} image(s)`] : []),
      ...(textFiles ?? []).map((f) => f.name),
    ];
    const userDisplay = text || (attachLabels.length ? `📎 ${attachLabels.join(', ')}` : '');
    unifiedChat.addMessage('user', userDisplay);
    unifiedChatHistory.push({ type: 'message', role: 'user', text: userDisplay });
    deps.scheduleSessionSnapshot();

    const stream = unifiedChat.beginAssistant();
    const id = ucId();
    const lang = detectLanguage(text + ' ' + ctx.editor.getDoc().slice(0, 400));
    const styleStr = mode === 'advise'
      ? styleDirective({ ...currentStyle(), naturalness: 'off' }, lang)
      : styleDirective(currentStyle(), lang);
    const instructions = buildUnifiedChatInstructions({
      styleDirectiveStr: styleStr,
      documentText: (mode === 'advise' && adviceSnapshot ? adviceSnapshot : ctx.editor.getDoc()).slice(0, 12000),
    });
    const cleanup = window.api.onAiChatEvent(id, (e) => {
      if (e.kind === 'delta' && e.text) {
        stream.pushDelta(e.text);
      } else if (e.kind === 'done') {
        const final = stream.finalize(e.text);
        unifiedChatHistory.push({ type: 'message', role: 'assistant', text: final });
        deps.scheduleSessionSnapshot();
        cleanup();
        ucInflight = null;
        unifiedChat.completeRequest();
        unifiedChat.setStreaming(false);
      } else if (e.kind === 'error') {
        stream.fail(e.message ?? t('status.aiError'));
        ctx.setStatus(e.message ?? t('status.aiError'));
        cleanup();
        ucInflight = null;
        unifiedChat.failRequest();
        unifiedChat.setStreaming(false);
      }
    });
    ucInflight = { id, cleanup };

    try {
      await window.api.aiChat(id, instructions, priorTurns, aiText, currentModelArg(), mode === 'write' ? 'write' : 'advise', attachments);
    } catch (err: any) {
      stream.fail(err?.message ?? String(err));
      cleanup();
      ucInflight = null;
      unifiedChat.failRequest();
      unifiedChat.setStreaming(false);
    }
  }

  function syncAdviceSnapshot() {
    adviceSnapshot = ctx.editor.getDoc();
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    unifiedChat.setAdviceSync(`${t('uc.advise.synced')} · ${time}`);
  }

  function htmlExportSourceCharBudget(model: string | { provider: string; id: string } | undefined): number {
    const provider = typeof model === 'object' && model ? model.provider : 'chatgpt';
    const id = typeof model === 'string' ? model : typeof model === 'object' && model ? model.id : 'gpt-5.4-mini';
    const ctxTokens = isAiProviderId(provider) ? modelContextWindowTokens(provider, id) : 400_000;
    return Math.floor(ctxTokens * 3 * 0.6);
  }

  function runHtmlGeneration(prompt: string, model?: { provider: AiProviderId; id: string }): { result: Promise<string>; cancel: () => void } {
    const modelArg = model ?? currentModelArg();
    let cancelled = false;
    let activeCancel = () => {};
    const isTransient = (m: string) => /terminated|network|stream error|econnreset|socket hang/i.test(m);
    const attempt = (): Promise<string> => new Promise<string>((resolve, reject) => {
      const id = ucId();
      let buffer = '';
      const cleanup = window.api.onAiChatEvent(id, (e) => {
        if (e.kind === 'delta' && e.text) {
          buffer += e.text;
        } else if (e.kind === 'done') {
          cleanup();
          resolve(e.text ?? buffer);
        } else if (e.kind === 'error') {
          cleanup();
          reject(new Error(e.message ?? t('status.aiError')));
        }
      });
      activeCancel = () => {
        void window.api.aiCancel(id);
        cleanup();
      };
      window.api.aiChat(id, HTML_EXPORT_CONTENT_INSTRUCTIONS, [], prompt, modelArg).catch((err) => {
        cleanup();
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });
    const result = (async () => {
      try {
        return await attempt();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!cancelled && isTransient(msg)) return await attempt();
        throw err;
      }
    })();
    return { result, cancel: () => { cancelled = true; activeCancel(); } };
  }

  async function startHtmlExportWizard(guard: ToolPanelGuard) {
    const hasAuth = await window.api.aiHasAnyAuth().catch(() => true);
    if (!guard.isCurrent()) return;
    if (!hasAuth) {
      setUnifiedChatOpen(true);
      unifiedChat.addMessage('assistant', t('chat.noProvider'));
      ctx.setStatus(t('status.connectProvider'));
      openSettings();
      return;
    }
    if (!guard.isCurrent()) return;
    setUnifiedChatOpen(true);
    unifiedChat.showPanel('<div class="he-host"></div>', undefined, () => {
      htmlExportWizard?.destroy();
      htmlExportWizard = null;
    });
    const host = unifiedChatHost.querySelector<HTMLElement>('.he-host');
    if (!host) return;
    htmlExportWizard?.destroy();
    htmlExportWizard = mountHtmlExportWizard(host, {
      getMarkdown: () => ctx.editor.getDoc(),
      maxSourceCharsForModel: (m) => htmlExportSourceCharBudget(m ?? currentModelArg()),
      listHtmlModels: async () => {
        const ms = await deps.loadModelsCached(true);
        return ms.map((m) => {
          const provider = m.provider ?? 'chatgpt';
          return {
            provider,
            id: m.id,
            label: m.label,
            contextWindow: isAiProviderId(provider) ? modelContextWindowTokens(provider, m.id, m.contextWindow) : undefined,
          };
        });
      },
      getDefaultModel: () => deps.prefs.htmlModel ?? currentModelArg(),
      onModelChosen: (m) => {
        if (isAiProviderId(m.provider)) {
          deps.prefs.htmlModel = { provider: m.provider, id: m.id };
          savePrefs(deps.prefs);
        }
      },
      getCurrentPath: () => ctx.currentPath,
      getPendingTitle: () => ctx.pendingTitle,
      fetchDesignMd: (input) => window.api.fetchDesignMd(input),
      listDesigns: () => window.api.listDesigns(),
      saveHtml: (args) => window.api.saveHtml(args),
      openSavedHtml: (filePath) => window.api.openSavedHtml(filePath),
      aiGenerate: (prompt, model) => runHtmlGeneration(prompt, model && isAiProviderId(model.provider) ? { provider: model.provider, id: model.id } : undefined),
      openExternal: (url) => void window.api.openExternal(url),
      onCancel: () => ctx.setStatus(t('status.htmlExportCanceled')),
      t,
    });
  }

  const unifiedChat = mountUnifiedChat(unifiedChatHost, {
    onSend: (text, mode, attachments, textFiles) => {
      if (mode === 'project' || mode === 'html') return;
      void sendUnified(text, mode, attachments, textFiles);
    },
    convertFile: (base64, ext) => window.api.convertAttachment(base64, ext),
    onInsert: (md) => applyAiOutput('insert', '\n' + md.trim() + '\n'),
    onReplace: (md) => {
      const next = md.trim();
      const verdict = guardVerdict(ctx.editor.getDoc(), next);
      if (verdict.blockApply) {
        const lost = [
          ...verdict.comparison.missingNumbers,
          ...verdict.comparison.missingInlineCode,
          ...verdict.comparison.missingCode,
          ...verdict.comparison.missingQuotes,
        ].slice(0, 6).join(', ');
        const lostSuffix = lost ? ` (${lost})` : '';
        const ok = window.confirm(t('guard.confirm').replace('{lost}', lostSuffix));
        if (!ok) {
          ctx.setStatus(t('status.replaceCanceled'));
          return;
        }
      } else if (verdict.overHumanized) {
        ctx.setStatus(t('status.heavyRewrite'));
      }
      applyAiOutput('replace', next);
    },
    onCopy: (md) => void navigator.clipboard.writeText(md),
    onProjectSetup: deps.onProjectSetup,
    onHtmlExport: (guard) => void startHtmlExportWizard(guard),
    onModeChange: (mode) => { if (mode === 'advise') syncAdviceSnapshot(); },
    onAdviceResync: syncAdviceSnapshot,
    style: { get: currentStyle, onChange: applyStyle },
  });

  let ucResizing = false;
  ucResizer.addEventListener('mousedown', (e) => {
    if (!ucOpen) return;
    ucResizing = true;
    e.preventDefault();
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
  });
  window.addEventListener('mousemove', (e) => {
    if (!ucResizing) return;
    const requested = window.innerWidth - e.clientX;
    const width = clampChatWidth(requested, window.innerWidth);
    contentRow.style.setProperty('--uc-width', `${width}px`);
  });
  window.addEventListener('mouseup', () => {
    if (!ucResizing) return;
    ucResizing = false;
    document.body.style.userSelect = '';
    document.body.style.cursor = '';
  });


  return {
    unifiedChat,
    toggleUnifiedChat,
    setUnifiedChatOpen,
    cancelInflight: () => {
      if (ucInflight) void window.api.aiCancel(ucInflight.id);
    },
    currentStyle,
    openSettings,
    paintAuthPill,
    getHistory: () => unifiedChatHistory,
    setHistory: (history) => { unifiedChatHistory = history; },
  };
}
