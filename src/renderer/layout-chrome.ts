import { mountLeftPanel } from './left-panel';
import type { AppContext } from './app-context';
import type { Prefs } from './prefs';
import type { savePrefs } from './prefs';

type LayoutChromeDeps = {
  workspace: HTMLElement;
  leftPanelHost: HTMLDivElement;
  prefs: Prefs;
  savePrefs: typeof savePrefs;
  folderFromFilePath: (path: string) => string;
  saveIfDirtyBeforeReplace: () => Promise<boolean>;
};

export function initLayoutChrome(ctx: AppContext, deps: LayoutChromeDeps) {
  function isWithinRoot(path: string, root: string): boolean {
    if (path === root) return true;
    return path.startsWith(root.endsWith('/') ? root : root + '/');
  }

  const leftPanel = mountLeftPanel(deps.leftPanelHost, {
    getPreviewRoot: () => ctx.preview.el,
    onJump: (el) => el.scrollIntoView({ block: 'center' }),
    files: {
      getCurrentPath: () => ctx.currentPath,
      getWorkspaceRoot: () => deps.prefs.workspaceRoot ?? null,
      onWorkspaceRootChange: (root) => {
        if (root) deps.prefs.workspaceRoot = root;
        else delete deps.prefs.workspaceRoot;
        deps.savePrefs(deps.prefs);
      },
      listDir: (rootPath, dirPath) => window.api.listDir(rootPath, dirPath),
      openFolder: () => window.api.openFolder(),
      openFileInCurrent: (filePath) => window.api.openFileInCurrent(filePath),
      openExternalPath: (filePath) => window.api.openPath(filePath),
      saveIfDirtyBeforeReplace: deps.saveIfDirtyBeforeReplace,
    },
  });

  function syncWorkspaceRootToCurrent(): void {
    if (!ctx.currentPath) return;
    const parent = deps.folderFromFilePath(ctx.currentPath);
    if (!parent) return;
    const existing = deps.prefs.workspaceRoot ?? null;
    const desired = existing && isWithinRoot(ctx.currentPath, existing) ? existing : parent;
    if (desired !== existing) {
      deps.prefs.workspaceRoot = desired;
      deps.savePrefs(deps.prefs);
    }
    leftPanel.setWorkspaceRoot(desired);
  }

  ctx.preview.onAfterRender(() => leftPanel.refresh());
  let leftPanelOpen = true;
  function setLeftPanelOpen(open: boolean) {
    leftPanelOpen = open;
    document.querySelector('.content-row')?.classList.toggle('left-open', open);
    if (open) leftPanel.refresh();
  }
  function toggleLeftPanel() {
    setLeftPanelOpen(!leftPanelOpen);
  }
  setLeftPanelOpen(true);

  return { syncWorkspaceRootToCurrent, toggleLeftPanel, setWorkspaceRoot: leftPanel.setWorkspaceRoot };
}

type SplitDragDeps = {
  workspace: HTMLElement;
  splitterEl: HTMLElement;
  prefs: Prefs;
  savePrefs: typeof savePrefs;
  scheduleLineAlign: () => void;
};

export function initSplitDrag(deps: SplitDragDeps) {
  let dragging = false;
  deps.splitterEl.addEventListener('mousedown', (event) => {
    event.preventDefault();
    dragging = true;
    deps.splitterEl.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  });
  window.addEventListener('mousemove', (event) => {
    if (!dragging) return;
    const rect = deps.workspace.getBoundingClientRect();
    const ratio = Math.max(0.1, Math.min(0.9, (event.clientX - rect.left) / rect.width));
    deps.workspace.style.setProperty('--split-left', `${ratio}fr`);
    deps.workspace.style.setProperty('--split-right', `${1 - ratio}fr`);
  });
  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    deps.splitterEl.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    const columns = getComputedStyle(deps.workspace).gridTemplateColumns.split(' ');
    if (columns.length >= 3) {
      const left = parseFloat(columns[0]);
      const right = parseFloat(columns[2]);
      if (Number.isFinite(left) && Number.isFinite(right) && left + right > 0) {
        deps.prefs.splitRatio = left / (left + right);
        deps.savePrefs(deps.prefs);
      }
    }
    deps.scheduleLineAlign();
  });
}
