import { EditorSelection } from '@codemirror/state';
import { mountHtmlExportWizard, type HtmlExportWizardHandle } from './html-export-wizard';
import { clampChatWidth } from './chat-layout';
import { guardVerdict } from './humanize-guards';
import { styleDirective, detectLanguage, type Naturalness } from './humanize-engine';
import { t } from './i18n';
import { modelContextWindowTokens } from '../main/ai/output-budget';
import { isAiProviderId, type AiProviderId, type ProviderAuthStatus } from '../main/ai/types';
import {
  filterHtmlExportModels,
  htmlCapableProviderIds,
  isHtmlExportModelProviderAllowed,
} from '../main/ai/html-export-model-allowlist';
import { openSettingsModal, triggerCliOnboarding } from './settings-modal';
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

/** Last successful HTML-capable provider set for this renderer session. */
let lastHtmlCapableProviderIds: Set<AiProviderId> | null = null;

/**
 * Resolve the effective HTML-capable provider set with last-known-safe continuity.
 * - Successful status fetch → use (and cache) the live set.
 * - Failed fetch + non-null cache → reuse the cached set (fail-closed continuity).
 * - Failed fetch + null cache → null (pre-gate fallback: entry opens, picker allowlist-only).
 */
export function resolveHtmlCapableProviderIds(
  statuses: ProviderAuthStatus[] | null,
  cache: Set<AiProviderId> | null,
  localProvidersWithModels: ReadonlySet<AiProviderId> = new Set(),
): { capable: Set<AiProviderId> | null; nextCache: Set<AiProviderId> | null } {
  if (statuses) {
    const capable = htmlCapableProviderIds(statuses, { localProvidersWithModels });
    return { capable, nextCache: capable };
  }
  return { capable: cache, nextCache: cache };
}

function htmlLocalProvidersWithModels(models: readonly { provider?: string }[]): Set<AiProviderId> {
  const providers = new Set<AiProviderId>();
  for (const model of models) {
    if (model.provider === 'ollama' || model.provider === 'lmstudio') providers.add(model.provider);
  }
  return providers;
}

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
  tryMutateDocument: () => boolean;
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
    if (!deps.tryMutateDocument()) return;
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
      currentSelections: [
        deps.prefs.selectedModel,
        deps.prefs.blockSelectedModel,
        deps.prefs.htmlModel,
      ],
      onAfterAuthChange: () => {
        deps.invalidateModels();
        void deps.loadModelsCached(true);
        void window.api.aiReasoningCapabilities?.();
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
      triggerCliOnboarding(openSettings);
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
      await window.api.aiChat({
        id,
        instructions,
        history: priorTurns,
        userText: aiText,
        model: currentModelArg(),
        surfaceMode: mode === 'write' ? 'write' : 'advise',
        images: attachments,
        reasoningEffort: deps.prefs.reasoningEffort,
      });
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

  async function startHtmlExportWizard(guard: ToolPanelGuard) {
    // Force HTML local discovery BEFORE the generic auth gate. hasAnyAuth only
    // reads the existing local snapshot; local-only users who just started
    // Ollama/LM Studio would otherwise hit chat.noProvider and never reach the
    // awaited aiModelsHtml path that populates the cache (Codex P2 on #42).
    const htmlModels = await window.api.aiModelsHtml(true).catch(() => []);
    if (!guard.isCurrent()) return;
    const [statuses, hasAuth] = await Promise.all([
      window.api.aiProvidersStatus().catch(() => null),
      window.api.aiHasAnyAuth().catch(() => true),
    ]);
    if (!guard.isCurrent()) return;
    const localDiscovered = htmlLocalProvidersWithModels(htmlModels);
    // After forced discovery, local models alone are enough to attempt entry even
    // if a racing hasAnyAuth still saw an empty snapshot (defensive).
    if (!hasAuth && localDiscovered.size === 0) {
      setUnifiedChatOpen(true);
      unifiedChat.addMessage('assistant', t('chat.noProvider'));
      ctx.setStatus(t('status.connectProvider'));
      triggerCliOnboarding(openSettings);
      return;
    }
    // §5.3 honesty: generic auth is not enough — only open the wizard when at
    // least one provider can actually pin an HTML transport (Claude needs CLI).
    // Status-fetch failure reuses the last successful capable set (fail-closed
    // continuity). Cold failure (no cache yet) keeps the hasAuth/local gate so a
    // transient probe does not hard-break entry.
    const entryCapable = resolveHtmlCapableProviderIds(
      statuses,
      lastHtmlCapableProviderIds,
      localDiscovered,
    );
    lastHtmlCapableProviderIds = entryCapable.nextCache;
    if (entryCapable.capable && entryCapable.capable.size === 0) {
      setUnifiedChatOpen(true);
      unifiedChat.addMessage('assistant', t('chat.noProvider'));
      ctx.setStatus(t('status.connectProvider'));
      triggerCliOnboarding(openSettings);
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
        const ms = await window.api.aiModelsHtml(true);
        const mapped = ms.map((m) => {
          const provider = m.provider ?? 'chatgpt';
          return {
            provider,
            id: m.id,
            label: m.label,
            contextWindow: isAiProviderId(provider) ? modelContextWindowTokens(provider, m.id, m.contextWindow) : undefined,
          };
        });
        // §5.3 / AC-M1c-d: the HTML surface pins ONE no-fallback transport, so
        // OpenRouter (and any non-allowlisted provider) is hard-excluded from the
        // picker even if the general chat policy would reinject a current selection.
        const allowlisted = filterHtmlExportModels(mapped);
        // Drop models whose provider cannot run HTML right now (e.g. API-only Claude).
        // Status-fetch failure reuses the last successful capable set; only a cold
        // failure (no cache yet) falls back to allowlist-only.
        const liveStatuses = await window.api.aiProvidersStatus().catch(() => null);
        const pickerCapable = resolveHtmlCapableProviderIds(
          liveStatuses,
          lastHtmlCapableProviderIds,
          htmlLocalProvidersWithModels(ms),
        );
        lastHtmlCapableProviderIds = pickerCapable.nextCache;
        if (!pickerCapable.capable) return allowlisted;
        return allowlisted.filter((m) => isAiProviderId(m.provider) && pickerCapable.capable!.has(m.provider));
      },
      // Never preselect a provider the HTML surface forbids (fail-closed): a
      // persisted OpenRouter htmlModel/main model resolves to no default here.
      // Also drop an allowlisted-but-not-currently-HTML-capable default (e.g.
      // API-only Claude with no usable CLI) when the capable set is known (the
      // entry gate populates it), so a quick Generate cannot submit a default
      // that only fails at the CLI/main rejection. Cold (no cache) keeps
      // allowlist-only, matching the picker/entry continuity policy.
      getDefaultModel: () => {
        const d = deps.prefs.htmlModel ?? currentModelArg();
        if (!d) return undefined;
        const provider = typeof d === 'string' ? 'chatgpt' : d.provider;
        if (!isHtmlExportModelProviderAllowed(provider)) return undefined;
        if (
          lastHtmlCapableProviderIds &&
          isAiProviderId(provider) &&
          !lastHtmlCapableProviderIds.has(provider)
        ) {
          return undefined;
        }
        return d;
      },
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
      saveHtmlFinalized: (args) => window.api.saveHtmlFinalized(args),
      openSavedHtml: (filePath) => window.api.openSavedHtml(filePath),
      generateHtmlExport: (request) => window.api.generateHtmlExport(request),
      cancelHtmlGeneration: () => void window.api.cancelHtmlGeneration(),
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
