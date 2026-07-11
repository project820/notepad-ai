import type { EditorHandle } from './editor';
import type { PreviewHandle } from './preview';

export type PreviewMode = 'split' | 'editor-only' | 'preview-only';
type ActiveSurface = 'editor' | 'preview';

export type AppContext = {
  currentPath: string | null;
  pendingTitle: string | null;
  dirty: boolean;
  previewMode: PreviewMode;
  activeSurface: ActiveSurface;
  editingInPreview: boolean;
  suppressEditorChange: boolean;
  convertedHtml: string | null;
  showingConvertedHtml: boolean;
  readonly editor: EditorHandle;
  readonly preview: PreviewHandle;
  setHandles: (editor: EditorHandle, preview: PreviewHandle) => void;
  setStatus: (message: string) => void;
};

export function createAppContext(statusEl: HTMLElement): AppContext {
  let handles: { editor: EditorHandle; preview: PreviewHandle } | null = null;

  function getHandles() {
    if (!handles) throw new Error('App handles are not initialized');
    return handles;
  }

  return {
    currentPath: null,
    pendingTitle: null,
    dirty: false,
    previewMode: 'split',
    activeSurface: 'editor',
    editingInPreview: false,
    suppressEditorChange: false,
    convertedHtml: null,
    showingConvertedHtml: false,
    get editor() {
      return getHandles().editor;
    },
    get preview() {
      return getHandles().preview;
    },
    setHandles(editor, preview) {
      if (handles) throw new Error('App handles are already initialized');
      handles = { editor, preview };
    },
    setStatus: (message) => {
      statusEl.textContent = message;
    },
  };
}
