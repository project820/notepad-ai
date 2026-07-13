import { createToolbar, type FontSize, type Theme } from './toolbar';
import { applyToEditor, applyToPreview, type FormatAction } from './formatting';
import { type Prefs, savePrefs, applyTheme, applyFontSize, resolvedDark } from './prefs';
import { clampTypography, type TypographyPref } from './typography';
import { parseModelKey } from './model-key';
import { openLoginModal } from './login-modal';
import type { AppContext } from './app-context';
import type { AuthSnapshot } from '../shared/auth-protocol';
import type { t, getLocale } from './i18n';
import type { RendererModel } from './model-cache';

type ToolbarWiringDeps = {
  toolbarHost: HTMLElement;
  prefs: Prefs;
  t: typeof t;
  getLocale: typeof getLocale;
  loadModelsCached: (force?: boolean) => Promise<RendererModel[]>;
  getAuth: () => AuthSnapshot;
  setAuth: (auth: AuthSnapshot) => void;
  paintAuthPill: (auth: AuthSnapshot) => void;
  requestLocaleRestart: (locale: ReturnType<typeof getLocale>, persist: () => void) => Promise<boolean>;
  toggleUnifiedChat: () => void;
  toggleLeftPanel: () => void;
  openSettings: () => void;
  applyTypography: (pref: TypographyPref) => void;
  scheduleLineAlign: () => void;
  syncPreviewToSource: () => void;
  cyclePreviewMode: () => void;
  flushPreviewToSource: () => boolean;
  tryMutateDocument: () => boolean;
};

export function initToolbarWiring(ctx: AppContext, deps: ToolbarWiringDeps) {
  function dispatchFormat(action: FormatAction) {
    if (ctx.previewMode === 'preview-only') ctx.activeSurface = 'preview';
    if (ctx.previewMode === 'editor-only') ctx.activeSurface = 'editor';
    if (action === 'footnote') {
      if (ctx.activeSurface === 'preview' && ctx.editingInPreview) deps.flushPreviewToSource();
      if (!deps.tryMutateDocument()) return;
      applyToEditor(ctx.editor.view, 'footnote');
      if (ctx.activeSurface === 'preview') {
        ctx.editingInPreview = false;
        ctx.preview.setDoc(ctx.editor.getDoc());
      }
      return;
    }
    if (ctx.activeSurface === 'preview') {
      if (!deps.tryMutateDocument()) return;
      const inTableCell = !!(document.activeElement as HTMLElement | null)?.closest('.preview-table-wrap');
      if (!ctx.preview.el.contains(document.activeElement)) ctx.preview.el.focus({ preventScroll: true });
      applyToPreview(action);
      if (!inTableCell) {
        ctx.editingInPreview = true;
        deps.syncPreviewToSource();
      }
    } else {
      if (!deps.tryMutateDocument()) return;
      applyToEditor(ctx.editor.view, action);
    }
  }

  createToolbar(deps.toolbarHost, {
    getTheme: () => deps.prefs.theme,
    getFontSize: () => deps.prefs.fontSize,
    getModel: () => deps.prefs.selectedModel ?? deps.prefs.model ?? 'gpt-5.4-mini',
    getLocale: () => deps.getLocale(),
    getAuth: deps.getAuth,
    loadModels: (force) => deps.loadModelsCached(force),
    onModelChange: (key) => {
      const { provider, id } = parseModelKey(key);
      deps.prefs.selectedModel = { provider, id };
      if (provider === 'chatgpt') deps.prefs.model = id;
      savePrefs(deps.prefs);
      ctx.setStatus(deps.t('status.model').replace('{model}', id));
    },
    onLocaleChange: (locale) => {
      if (locale === deps.getLocale()) return;
      void deps.requestLocaleRestart(locale, () => {
        deps.prefs.locale = locale;
        savePrefs(deps.prefs);
      });
    },
    onToggleSideChat: deps.toggleUnifiedChat,
    onToggleOutline: deps.toggleLeftPanel,
    onUndo: () => {
      if (!deps.tryMutateDocument()) return;
      if (ctx.activeSurface === 'preview' && ctx.editingInPreview) deps.flushPreviewToSource();
      ctx.editor.undo();
      ctx.preview.setDoc(ctx.editor.getDoc());
    },
    onRedo: () => {
      if (!deps.tryMutateDocument()) return;
      if (ctx.activeSurface === 'preview' && ctx.editingInPreview) deps.flushPreviewToSource();
      ctx.editor.redo();
      ctx.preview.setDoc(ctx.editor.getDoc());
    },
    onTogglePreviewLines: () => { const next = !(deps.prefs.previewLineNumbers ?? false); deps.prefs.previewLineNumbers = next; savePrefs(deps.prefs); ctx.preview.setLineNumbers(next); },
    getPreviewLines: () => deps.prefs.previewLineNumbers ?? false,
    onToggleRawLineAlign: () => { deps.prefs.rawLineAlign = !(deps.prefs.rawLineAlign ?? false); savePrefs(deps.prefs); deps.scheduleLineAlign(); },
    getRawLineAlign: () => deps.prefs.rawLineAlign ?? false,
    getTypography: () => clampTypography(deps.prefs.typography),
    onTypographyChange: (next) => { deps.prefs.typography = clampTypography(next); savePrefs(deps.prefs); deps.applyTypography(deps.prefs.typography); deps.scheduleLineAlign(); },
    onOpenSettings: deps.openSettings,
    getReasoningEffort: () => deps.prefs.reasoningEffort,
    onReasoningEffortChange: (effort) => {
      deps.prefs.reasoningEffort = effort;
      savePrefs(deps.prefs);
    },
    loadReasoningCapabilities: () => window.api.aiReasoningCapabilities(),
    onSignIn: () => openLoginModal({ onAfterLogin: (auth) => {
      deps.setAuth(auth);
      deps.paintAuthPill(auth);
      void window.api.aiReasoningCapabilities?.();
    } }),
    onSignOut: async () => {
      await window.api.authLogout();
      void window.api.aiReasoningCapabilities?.();
      const auth = { signedIn: false };
      deps.setAuth(auth);
      deps.paintAuthPill(auth);
      ctx.setStatus(deps.t('status.signedOut'));
    },
    onFormat: dispatchFormat,
    onInsertTable: (rows, cols) => {
      if (!deps.tryMutateDocument()) return;
      ctx.editor.insertTable(rows, cols);
      ctx.setStatus(deps.t('status.tableInserted').replace('{rows}', String(rows)).replace('{cols}', String(cols)));
    },
    onTogglePreview: deps.cyclePreviewMode,
    onThemeChange: (theme: Theme) => { deps.prefs.theme = theme; savePrefs(deps.prefs); applyTheme(theme); ctx.editor.applyTheme(resolvedDark(theme)); },
    onFontSizeChange: (size: FontSize) => { deps.prefs.fontSize = size; savePrefs(deps.prefs); applyFontSize(size); deps.scheduleLineAlign(); },
  });

  return { dispatchFormat };
}
