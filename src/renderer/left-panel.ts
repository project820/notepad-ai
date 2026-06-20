/**
 * Left collapsible panel (#7 + v0.4) — a tabbed side panel with two tabs:
 *
 *  - "Outline" tab: document outline (H1–H3) + footnote list, built from the
 *    rendered preview. Clicking an item jumps to it (unchanged behaviour).
 *  - "Files" tab (v0.4): a lazy, IPC-backed file tree rooted at a workspace
 *    folder. Folders read one level on expand (lazy `listDir`). Openable
 *    documents open in the current window — going through a dirty-save prompt and
 *    the multi-window duplicate-owner guard — while other files open in the OS
 *    default app. Manual refresh only; no fs watch.
 *
 * Push layout (not overlay). Pure builders/helpers (`buildOutline`,
 * `buildFootnotes`, `filterEntries`, `entryRowClasses`, `escapeHtml`) are
 * unit-testable; `mountLeftPanel` wires the DOM.
 */

import { t } from './i18n';
import type { FileTreeEntry } from '../shared/file-types';

export type OutlineItem = { id: string; level: number; text: string };
export type FootnoteItem = { id: string; text: string };

/** Collect H1–H3 headings from the preview, assigning ids where missing. */
export function buildOutline(root: HTMLElement): OutlineItem[] {
  const heads = Array.from(root.querySelectorAll<HTMLElement>('h1, h2, h3'));
  return heads.map((h, i) => {
    if (!h.id) h.id = `lp-h-${i}`;
    return { id: h.id, level: Number(h.tagName.slice(1)) || 1, text: (h.textContent ?? '').trim() };
  });
}

/** Collect footnote definitions from the preview. */
export function buildFootnotes(root: HTMLElement): FootnoteItem[] {
  const items = Array.from(root.querySelectorAll<HTMLElement>('.footnotes li, li.footnote-item'));
  return items
    .filter((li) => li.id)
    .map((li) => ({ id: li.id, text: (li.textContent ?? '').replace(/↩\uFE0E?/g, '').trim() }));
}

/** Escape text for safe interpolation into innerHTML. Exported for testing. */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Pure: narrow a directory's entries by a case-insensitive substring filter.
 * An empty/whitespace query returns a copy of the input unchanged.
 */
export function filterEntries(entries: readonly FileTreeEntry[], query: string): FileTreeEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return entries.slice();
  return entries.filter((e) => e.name.toLowerCase().includes(q));
}

/**
 * Pure: CSS class list for a tree row. Directories get `ft-dir`; files get
 * `ft-file`, a kind class (`ft-kind-<kind>`) for icon/colour, and either
 * `ft-openable` (Notepad AI can open it) or `ft-dim` (opens in the OS app).
 */
export function entryRowClasses(entry: Pick<FileTreeEntry, 'isDir' | 'openable' | 'kind'>): string {
  const cls = ['ft-row'];
  if (entry.isDir) {
    cls.push('ft-dir');
  } else {
    cls.push('ft-file', `ft-kind-${entry.kind}`, entry.openable ? 'ft-openable' : 'ft-dim');
  }
  return cls.join(' ');
}

/** Last path segment of an absolute path (display name for the workspace root). */
function basename(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : p;
}

/** Result shape of the `file:open-in-current` IPC, mirrored from preload. */
type OpenInCurrentResult = {
  opened: boolean;
  focusedOwner?: boolean;
  ownerWindowId?: number;
  error?: string;
};

/** File-tree dependencies. Absent → the panel renders the outline only (no tabs). */
export type FileTreeDeps = {
  /** Path of the document open in this window (for current-file highlight). */
  getCurrentPath: () => string | null;
  /** Last persisted workspace root, restored on mount. */
  getWorkspaceRoot: () => string | null;
  /** Notify the host that the user changed the root (persist to prefs). */
  onWorkspaceRootChange: (root: string | null) => void;
  /** Lazy one-level directory read. */
  listDir: (
    rootPath: string,
    dirPath: string,
  ) => Promise<{ ok: boolean; entries: FileTreeEntry[]; error?: string }>;
  /** Open the OS folder picker; resolves to the chosen path or null. */
  openFolder: () => Promise<string | null>;
  /** Open an openable document in the current window (duplicate-owner guarded). */
  openFileInCurrent: (filePath: string) => Promise<OpenInCurrentResult>;
  /** Open a non-openable file in the OS default app. */
  openExternalPath: (filePath: string) => Promise<{ ok: boolean; error?: string }>;
  /**
   * Prompt to save the current document if dirty before it is replaced.
   * Resolves true to proceed with opening, false to abort (user cancelled or
   * the save failed).
   */
  saveIfDirtyBeforeReplace: () => Promise<boolean>;
};

export type LeftPanelOpts = {
  getPreviewRoot: () => HTMLElement;
  onJump: (el: HTMLElement) => void;
  files?: FileTreeDeps;
};

export type LeftPanelHandle = {
  /** Re-render the outline tab from the current preview (no-op on the files tab). */
  refresh: () => void;
  destroy: () => void;
  /** Set/restore the file-tree root (called by the host on document open). */
  setWorkspaceRoot: (root: string | null) => void;
  /** Re-read the root and any expanded folders (manual refresh). */
  refreshFiles: () => void;
};

type Tab = 'outline' | 'files';
type DirState = { entries: FileTreeEntry[] | null; loading: boolean; error: boolean };

export function mountLeftPanel(host: HTMLElement, opts: LeftPanelOpts): LeftPanelHandle {
  const files = opts.files;
  const hasFiles = !!files;

  let activeTab: Tab = 'outline';

  // ----- file-tree state -----
  const dirCache = new Map<string, DirState>();
  const expanded = new Set<string>();
  let root: string | null = files ? files.getWorkspaceRoot() : null;
  let filterQuery = '';
  let fileStatus = '';

  // ---------------------------------------------------------------- outline
  function outlineHtml(): string {
    const previewRoot = opts.getPreviewRoot();
    const outline = buildOutline(previewRoot);
    const footnotes = buildFootnotes(previewRoot);

    const outlineItems = outline.length
      ? outline
          .map(
            (o) =>
              `<button class="lp-item lp-h${o.level}" data-target="${escapeHtml(o.id)}" type="button">${escapeHtml(o.text || '(untitled)')}</button>`,
          )
          .join('')
      : `<div class="lp-empty">${escapeHtml(t('panel.outlineEmpty'))}</div>`;

    const footItems = footnotes.length
      ? footnotes
          .map(
            (f, i) =>
              `<button class="lp-item lp-fn" data-target="${escapeHtml(f.id)}" type="button"><span class="lp-fn-n">${i + 1}</span>${escapeHtml(f.text.slice(0, 80))}</button>`,
          )
          .join('')
      : `<div class="lp-empty">${escapeHtml(t('panel.footnotesEmpty'))}</div>`;

    return `
      <div class="lp-section">
        <div class="lp-title">${escapeHtml(t('panel.outline'))}</div>
        <div class="lp-list">${outlineItems}</div>
      </div>
      <div class="lp-section">
        <div class="lp-title">${escapeHtml(t('panel.footnotes'))}</div>
        <div class="lp-list">${footItems}</div>
      </div>`;
  }

  // ------------------------------------------------------------------ files
  function noteHtml(text: string, depth: number, isError = false): string {
    return `<div class="ft-note${isError ? ' ft-error' : ''}" style="padding-left:${8 + depth * 14}px">${escapeHtml(text)}</div>`;
  }

  function renderRow(entry: FileTreeEntry, depth: number): string {
    const cls = entryRowClasses(entry);
    const current = hasFiles && files!.getCurrentPath() === entry.path ? ' ft-current' : '';
    const caret = entry.isDir
      ? `<span class="ft-caret" aria-hidden="true">${expanded.has(entry.path) ? '▾' : '▸'}</span>`
      : '<span class="ft-caret ft-caret-none" aria-hidden="true"></span>';
    const icon = `<span class="ft-icon ft-icon-${entry.isDir ? 'folder' : entry.kind}" aria-hidden="true"></span>`;
    return (
      `<button class="${cls}${current}" type="button"` +
      ` data-path="${escapeHtml(entry.path)}" data-dir="${entry.isDir ? '1' : '0'}"` +
      ` data-openable="${entry.openable ? '1' : '0'}"` +
      ` style="padding-left:${8 + depth * 14}px" title="${escapeHtml(entry.name)}">` +
      `${caret}${icon}<span class="ft-name">${escapeHtml(entry.name)}</span></button>`
    );
  }

  function buildLevel(dirPath: string, depth: number): string {
    const st = dirCache.get(dirPath);
    if (!st || (st.loading && !st.entries)) return noteHtml(t('panel.files.loading'), depth);
    if (st.error) return noteHtml(t('panel.files.error'), depth, true);
    const entries = filterEntries(st.entries ?? [], filterQuery);
    if (entries.length === 0) {
      return depth === 0 ? `<div class="ft-empty">${escapeHtml(t('panel.files.emptyDir'))}</div>` : '';
    }
    return entries
      .map((e) => {
        const row = renderRow(e, depth);
        return e.isDir && expanded.has(e.path) ? row + buildLevel(e.path, depth + 1) : row;
      })
      .join('');
  }

  function buildTreeHtml(): string {
    if (!root) return `<div class="ft-empty">${escapeHtml(t('panel.files.empty'))}</div>`;
    return buildLevel(root, 0);
  }

  function filesHtml(): string {
    const name = root ? escapeHtml(basename(root)) : escapeHtml(t('panel.files.empty'));
    const rootTitle = root ? ` title="${escapeHtml(root)}"` : '';
    const openLabel = escapeHtml(t('panel.files.openFolder'));
    const refreshLabel = escapeHtml(t('panel.files.refresh'));
    return (
      `<div class="ft-head">` +
      `<div class="ft-root"${rootTitle}>${name}</div>` +
      `<button class="ft-action ft-action-refresh" data-action="refresh" type="button" title="${refreshLabel}" aria-label="${refreshLabel}">↻</button>` +
      `</div>` +
      `<button class="ft-action ft-open-folder" data-action="open-folder" type="button">${openLabel}</button>` +
      `<input class="ft-filter" type="text" placeholder="${escapeHtml(t('panel.files.filter'))}" aria-label="${escapeHtml(t('panel.files.filter'))}" value="${escapeHtml(filterQuery)}" />` +
      `<div class="ft-status" role="status">${escapeHtml(fileStatus)}</div>` +
      `<div class="ft-tree">${buildTreeHtml()}</div>`
    );
  }

  // ------------------------------------------------------------- rendering
  function bodyEl(): HTMLElement | null {
    return host.querySelector<HTMLElement>('.lp-body');
  }
  function treeEl(): HTMLElement | null {
    return host.querySelector<HTMLElement>('.ft-tree');
  }

  function renderTree(): void {
    const tree = treeEl();
    if (tree) tree.innerHTML = buildTreeHtml();
  }

  function setStatus(msg: string): void {
    fileStatus = msg;
    const el = host.querySelector<HTMLElement>('.ft-status');
    if (el) el.textContent = msg;
  }

  function renderActive(): void {
    const body = bodyEl();
    if (!body) return;
    if (activeTab === 'files' && hasFiles) {
      body.innerHTML = filesHtml();
      ensureRootLoaded();
    } else {
      body.innerHTML = outlineHtml();
    }
  }

  function tabButton(id: Tab, label: string): string {
    const on = activeTab === id;
    return `<button class="lp-tab${on ? ' active' : ''}" id="lp-tab-${id}" data-tab="${id}" type="button" role="tab" aria-selected="${on}" aria-controls="lp-panel">${escapeHtml(label)}</button>`;
  }

  function renderShell(): void {
    const tabs = hasFiles
      ? `<div class="lp-tabs" role="tablist">${tabButton('outline', t('panel.tab.outline'))}${tabButton('files', t('panel.tab.files'))}</div>`
      : '';
    // When tabs exist the body is the tabpanel for the active tab; without tabs
    // it is a plain region (no orphan tabpanel role without a tablist).
    const bodyAttrs = hasFiles
      ? ` id="lp-panel" role="tabpanel" tabindex="0" aria-labelledby="lp-tab-${activeTab}"`
      : '';
    host.innerHTML = `${tabs}<div class="lp-body"${bodyAttrs}></div>`;
    renderActive();
  }

  function setActiveTab(tab: Tab): void {
    if (tab === activeTab) return;
    activeTab = tab;
    host.querySelectorAll<HTMLElement>('.lp-tab').forEach((b) => {
      const on = b.dataset.tab === tab;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', String(on));
    });
    // Keep the tabpanel labelled by the now-active tab.
    bodyEl()?.setAttribute('aria-labelledby', `lp-tab-${tab}`);
    renderActive();
  }

  // ----------------------------------------------------------- file actions
  function ensureRootLoaded(): void {
    if (root && !dirCache.has(root)) void loadDir(root);
  }

  async function loadDir(dirPath: string): Promise<void> {
    if (!files || !root) return;
    const reqRoot = root;
    dirCache.set(dirPath, { entries: dirCache.get(dirPath)?.entries ?? null, loading: true, error: false });
    renderTree();
    try {
      const res = await files.listDir(reqRoot, dirPath);
      if (root !== reqRoot) return; // root changed mid-flight — drop stale result
      dirCache.set(
        dirPath,
        res.ok
          ? { entries: res.entries, loading: false, error: false }
          : { entries: null, loading: false, error: true },
      );
    } catch {
      if (root !== reqRoot) return;
      dirCache.set(dirPath, { entries: null, loading: false, error: true });
    }
    renderTree();
  }

  function toggleExpand(dirPath: string): void {
    if (expanded.has(dirPath)) {
      expanded.delete(dirPath);
      renderTree();
    } else {
      expanded.add(dirPath);
      if (dirCache.has(dirPath)) renderTree();
      else void loadDir(dirPath);
    }
  }

  async function openDoc(filePath: string): Promise<void> {
    if (!files) return;
    const proceed = await files.saveIfDirtyBeforeReplace();
    if (!proceed) return;
    setStatus('');
    const res = await files.openFileInCurrent(filePath);
    if (res.focusedOwner) {
      // Another window owns this path — main focused it; do NOT replace this
      // window. Surface a status hint only.
      setStatus(t('panel.files.ownerFocused'));
    } else if (!res.opened && res.error) {
      setStatus(res.error);
    }
  }

  async function openExternal(filePath: string): Promise<void> {
    if (!files) return;
    const res = await files.openExternalPath(filePath);
    if (!res.ok && res.error) setStatus(res.error);
  }

  function setRoot(next: string | null, notify: boolean): void {
    root = next;
    dirCache.clear();
    expanded.clear();
    filterQuery = '';
    fileStatus = '';
    if (notify && files) files.onWorkspaceRootChange(next);
    if (activeTab === 'files') renderActive();
  }

  async function chooseFolder(): Promise<void> {
    if (!files) return;
    const picked = await files.openFolder();
    if (picked) setRoot(picked, true);
  }

  function refreshFiles(): void {
    if (!root) return;
    const toReload = [root, ...Array.from(expanded)];
    dirCache.clear();
    setStatus('');
    renderTree();
    for (const p of toReload) void loadDir(p);
  }

  // ------------------------------------------------------------------ wiring
  const onClick = (e: Event) => {
    const target = e.target as HTMLElement;

    const tab = target.closest<HTMLElement>('.lp-tab');
    if (tab && tab.dataset.tab) {
      setActiveTab(tab.dataset.tab as Tab);
      return;
    }

    const action = target.closest<HTMLElement>('.ft-action');
    if (action) {
      if (action.dataset.action === 'open-folder') void chooseFolder();
      else if (action.dataset.action === 'refresh') refreshFiles();
      return;
    }

    const row = target.closest<HTMLElement>('.ft-row');
    if (row) {
      const p = row.dataset.path;
      if (!p) return;
      if (row.dataset.dir === '1') toggleExpand(p);
      else if (row.dataset.openable === '1') void openDoc(p);
      else void openExternal(p);
      return;
    }

    const item = target.closest<HTMLButtonElement>('.lp-item');
    if (!item) return;
    const id = item.dataset.target;
    if (!id) return;
    const targetEl = opts
      .getPreviewRoot()
      .querySelector<HTMLElement>(`[id="${id.replace(/["\\]/g, '\\$&')}"]`);
    if (targetEl) opts.onJump(targetEl);
  };

  const onInput = (e: Event) => {
    const el = e.target as HTMLElement;
    if (el instanceof HTMLInputElement && el.classList.contains('ft-filter')) {
      filterQuery = el.value;
      renderTree();
    }
  };

  host.addEventListener('click', onClick);
  host.addEventListener('input', onInput);
  renderShell();

  return {
    refresh: () => {
      if (activeTab === 'outline') renderActive();
    },
    destroy: () => {
      host.removeEventListener('click', onClick);
      host.removeEventListener('input', onInput);
      host.innerHTML = '';
    },
    setWorkspaceRoot: (next: string | null) => {
      if (next === root) {
        // Same root — just refresh the current-file highlight when visible.
        if (activeTab === 'files') renderTree();
        return;
      }
      setRoot(next, false);
    },
    refreshFiles,
  };
}
