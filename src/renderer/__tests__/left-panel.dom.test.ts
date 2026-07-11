// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  buildOutline,
  buildFootnotes,
  mountLeftPanel,
  filterEntries,
  entryRowClasses,
  escapeHtml,
  type FileTreeDeps,
} from '../left-panel';
import type { FileTreeEntry } from '../../shared/file-types';

afterEach(() => {
  document.body.innerHTML = '';
});

function previewWith(html: string): HTMLElement {
  const root = document.createElement('div');
  root.className = 'preview';
  root.innerHTML = html;
  document.body.appendChild(root);
  return root;
}

describe('buildOutline', () => {
  it('collects h1-h3 (not h4+) and assigns ids when missing', () => {
    const root = previewWith('<h1>Title</h1><h2 id="x">Sub</h2><h3>Deep</h3><h4>Ignored</h4>');
    const out = buildOutline(root);
    expect(out.map((o) => o.text)).toEqual(['Title', 'Sub', 'Deep']);
    expect(out.map((o) => o.level)).toEqual([1, 2, 3]);
    expect(out[1].id).toBe('x');
    expect(out[0].id).toBeTruthy();
  });
});

describe('buildFootnotes', () => {
  it('collects footnote items by id, stripping the backref arrow', () => {
    const root = previewWith(
      '<section class="footnotes"><ol><li id="fn1">first note <a class="footnote-backref">↩</a></li><li id="fn2">second</li></ol></section>',
    );
    const fns = buildFootnotes(root);
    expect(fns.map((f) => f.id)).toEqual(['fn1', 'fn2']);
    expect(fns[0].text).toContain('first note');
    expect(fns[0].text).not.toContain('↩');
  });
});

describe('mountLeftPanel', () => {
  it('renders outline + footnotes and jumps on click', () => {
    const root = previewWith('<h1 id="h1">Intro</h1><p>x<sup class="footnote-ref"><a href="#fn1">[1]</a></sup></p><section class="footnotes"><ol><li id="fn1">a note</li></ol></section>');
    (Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = vi.fn();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const onJump = vi.fn();
    mountLeftPanel(host, { getPreviewRoot: () => root, onJump });
    expect(host.querySelector('.lp-item')).not.toBeNull();
    // click the outline heading item
    host.querySelector<HTMLButtonElement>('.lp-item[data-target="h1"]')!.click();
    expect(onJump).toHaveBeenCalledTimes(1);
    expect((onJump.mock.calls[0][0] as HTMLElement).id).toBe('h1');
    // click the footnote item
    host.querySelector<HTMLButtonElement>('.lp-item[data-target="fn1"]')!.click();
    expect(onJump).toHaveBeenCalledTimes(2);
  });

  it('shows empty states when there are no headings/footnotes', () => {
    const root = previewWith('<p>just a paragraph</p>');
    const host = document.createElement('div');
    document.body.appendChild(host);
    mountLeftPanel(host, { getPreviewRoot: () => root, onJump: vi.fn() });
    expect(host.querySelectorAll('.lp-empty').length).toBe(2);
  });
});

// ---------------------------------------------------------------- v0.4 file tab

function entry(p: Partial<FileTreeEntry> & { name: string; path: string }): FileTreeEntry {
  return {
    name: p.name,
    path: p.path,
    isDir: p.isDir ?? false,
    ext: p.ext ?? '',
    openable: p.openable ?? false,
    kind: p.kind ?? 'other',
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));
async function waitFor(fn: () => unknown, tries = 30) {
  for (let i = 0; i < tries; i++) {
    if (fn()) return;
    await flush();
  }
  throw new Error('waitFor timed out');
}

const ROOT_ENTRIES: FileTreeEntry[] = [
  entry({ name: 'src', path: '/work/src', isDir: true, kind: 'folder' }),
  entry({ name: 'report.md', path: '/work/report.md', ext: 'md', openable: true, kind: 'markdown' }),
  entry({ name: 'image.png', path: '/work/image.png', ext: 'png', openable: false, kind: 'other' }),
];

function defaultDeps(over: Partial<FileTreeDeps> = {}): FileTreeDeps {
  return {
    getCurrentPath: vi.fn(() => null),
    getWorkspaceRoot: vi.fn(() => '/work'),
    onWorkspaceRootChange: vi.fn(),
    listDir: vi.fn(async (_root: string, dirPath: string) => {
      if (dirPath === '/work') return { ok: true, entries: ROOT_ENTRIES };
      if (dirPath === '/work/src')
        return {
          ok: true,
          entries: [entry({ name: 'app.md', path: '/work/src/app.md', ext: 'md', openable: true, kind: 'markdown' })],
        };
      return { ok: true, entries: [] };
    }),
    openFolder: vi.fn(async () => null),
    openFileInCurrent: vi.fn(async () => ({ opened: true })),
    openExternalPath: vi.fn(async () => ({ ok: true })),
    saveIfDirtyBeforeReplace: vi.fn(async () => true),
    ...over,
  };
}

function mountFiles(over: Partial<FileTreeDeps> = {}) {
  const root = previewWith('<h1 id="h1">Intro</h1>');
  const host = document.createElement('div');
  document.body.appendChild(host);
  const files = defaultDeps(over);
  const handle = mountLeftPanel(host, { getPreviewRoot: () => root, onJump: vi.fn(), files });
  return { host, handle, files };
}

async function showFilesTab(over: Partial<FileTreeDeps> = {}) {
  const ctx = mountFiles(over);
  ctx.host.querySelector<HTMLButtonElement>('.lp-tab[data-tab="files"]')!.click();
  await waitFor(() => ctx.host.querySelector('.ft-tree')?.children.length);
  return ctx;
}

describe('left-panel pure helpers', () => {
  it('filterEntries returns a copy on empty query and narrows case-insensitively', () => {
    const all = filterEntries(ROOT_ENTRIES, '');
    expect(all).toEqual(ROOT_ENTRIES);
    expect(all).not.toBe(ROOT_ENTRIES);
    expect(filterEntries(ROOT_ENTRIES, 'RE').map((e) => e.name)).toEqual(['report.md']);
    expect(filterEntries(ROOT_ENTRIES, '  ').length).toBe(3);
    expect(filterEntries(ROOT_ENTRIES, 'zzz')).toEqual([]);
  });

  it('entryRowClasses distinguishes dir / openable / dimmed', () => {
    expect(entryRowClasses({ isDir: true, openable: false, kind: 'folder' })).toBe('ft-row ft-dir');
    expect(entryRowClasses({ isDir: false, openable: true, kind: 'markdown' })).toBe(
      'ft-row ft-file ft-kind-markdown ft-openable',
    );
    expect(entryRowClasses({ isDir: false, openable: false, kind: 'other' })).toBe(
      'ft-row ft-file ft-kind-other ft-dim',
    );
  });

  it('escapeHtml escapes the HTML-significant characters', () => {
    expect(escapeHtml('<a> & "b"')).toBe('&lt;a&gt; &amp; &quot;b&quot;');
  });
});

describe('mountLeftPanel — file tab', () => {
  it('renders two tabs, defaults to outline, and keeps outline DOM intact', () => {
    const { host } = mountFiles();
    expect(host.querySelectorAll('.lp-tab').length).toBe(2);
    expect(host.querySelector('.lp-tab[data-tab="outline"]')!.classList.contains('active')).toBe(true);
    // Outline content present; file tree not yet rendered (lazy).
    expect(host.querySelector('.lp-item')).not.toBeNull();
    expect(host.querySelector('.ft-tree')).toBeNull();
  });

  it('lazily lists the root only when the files tab is activated', async () => {
    const { host, files } = mountFiles();
    expect(files.listDir).not.toHaveBeenCalled();
    host.querySelector<HTMLButtonElement>('.lp-tab[data-tab="files"]')!.click();
    await waitFor(() => host.querySelector('.ft-row'));
    expect(files.listDir).toHaveBeenCalledWith('/work', '/work');
    expect(host.querySelector('.ft-root')!.textContent).toContain('work');
    const rows = host.querySelectorAll('.ft-row');
    expect(rows.length).toBe(3);
    expect(host.querySelector('.ft-row.ft-dir[data-path="/work/src"]')).not.toBeNull();
    expect(host.querySelector('.ft-row.ft-openable[data-path="/work/report.md"]')).not.toBeNull();
    expect(host.querySelector('.ft-row.ft-dim[data-path="/work/image.png"]')).not.toBeNull();
  });

  it('shows the empty-dir state when the root has no items', async () => {
    const { host } = await showFilesTab({ listDir: vi.fn(async () => ({ ok: true, entries: [] })) });
    expect(host.querySelector('.ft-empty')).not.toBeNull();
    expect(host.querySelector('.ft-row')).toBeNull();
  });

  it('shows the error state when listing fails', async () => {
    const { host } = mountFiles({ listDir: vi.fn(async () => ({ ok: false, entries: [], error: 'nope' })) });
    host.querySelector<HTMLButtonElement>('.lp-tab[data-tab="files"]')!.click();
    await waitFor(() => host.querySelector('.ft-note.ft-error'));
    expect(host.querySelector('.ft-note.ft-error')).not.toBeNull();
  });
  it('clears a persisted root that no longer has a main-process grant', async () => {
    const { host, files } = await showFilesTab({
      listDir: vi.fn(async () => ({ ok: false, entries: [], error: 'workspace-not-authorized' })),
    });

    await waitFor(() => vi.mocked(files.onWorkspaceRootChange).mock.calls.length);
    expect(files.onWorkspaceRootChange).toHaveBeenCalledWith(null);
    expect(host.querySelector('.ft-empty')?.textContent).toBe('Open a folder to browse files');
    expect(host.querySelector('.ft-action[data-action="open-folder"]')).not.toBeNull();
  });

  it('narrows the tree as the filter input changes', async () => {
    const { host } = await showFilesTab();
    const input = host.querySelector<HTMLInputElement>('.ft-filter')!;
    input.value = 'report';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const rows = host.querySelectorAll('.ft-row');
    expect(rows.length).toBe(1);
    expect(rows[0].getAttribute('data-path')).toBe('/work/report.md');
  });

  it('expands a folder lazily on click (one readdir per expand)', async () => {
    const { host, files } = await showFilesTab();
    host.querySelector<HTMLButtonElement>('.ft-row.ft-dir[data-path="/work/src"]')!.click();
    await waitFor(() => host.querySelector('.ft-row[data-path="/work/src/app.md"]'));
    expect(files.listDir).toHaveBeenCalledWith('/work', '/work/src');
    expect(host.querySelector('.ft-row[data-path="/work/src/app.md"]')).not.toBeNull();
  });

  it('opens an openable document through the dirty-save guard', async () => {
    const { host, files } = await showFilesTab();
    host.querySelector<HTMLButtonElement>('.ft-row.ft-openable[data-path="/work/report.md"]')!.click();
    await waitFor(() => vi.mocked(files.openFileInCurrent).mock.calls.length);
    expect(files.saveIfDirtyBeforeReplace).toHaveBeenCalled();
    expect(files.openFileInCurrent).toHaveBeenCalledWith('/work/report.md');
  });

  it('does not open when the dirty-save guard aborts', async () => {
    const { host, files } = await showFilesTab({ saveIfDirtyBeforeReplace: vi.fn(async () => false) });
    host.querySelector<HTMLButtonElement>('.ft-row.ft-openable[data-path="/work/report.md"]')!.click();
    await flush();
    expect(files.openFileInCurrent).not.toHaveBeenCalled();
  });

  it('shows a status hint when another window already owns the path', async () => {
    const { host } = await showFilesTab({
      openFileInCurrent: vi.fn(async () => ({ opened: false, focusedOwner: true, ownerWindowId: 2 })),
    });
    host.querySelector<HTMLButtonElement>('.ft-row.ft-openable[data-path="/work/report.md"]')!.click();
    await waitFor(() => host.querySelector('.ft-status')!.textContent);
    expect(host.querySelector('.ft-status')!.textContent).toBe('Already open in another window — switched to it.');
  });

  it('opens a non-openable file in the OS app instead of the current window', async () => {
    const { host, files } = await showFilesTab();
    host.querySelector<HTMLButtonElement>('.ft-row.ft-dim[data-path="/work/image.png"]')!.click();
    await waitFor(() => vi.mocked(files.openExternalPath).mock.calls.length);
    expect(files.openExternalPath).toHaveBeenCalledWith('/work/image.png');
    expect(files.openFileInCurrent).not.toHaveBeenCalled();
  });

  it('opening a folder via the button persists the new root', async () => {
    const { host, files } = await showFilesTab({ openFolder: vi.fn(async () => '/other') });
    host.querySelector<HTMLButtonElement>('.ft-action[data-action="open-folder"]')!.click();
    await waitFor(() => vi.mocked(files.onWorkspaceRootChange).mock.calls.length);
    expect(files.onWorkspaceRootChange).toHaveBeenCalledWith('/other');
    await waitFor(() => host.querySelector('.ft-root')!.textContent === 'other');
    expect(files.listDir).toHaveBeenCalledWith('/other', '/other');
  });

  it('manual refresh re-reads the root', async () => {
    const { host, files } = await showFilesTab();
    const before = vi.mocked(files.listDir).mock.calls.length;
    host.querySelector<HTMLButtonElement>('.ft-action[data-action="refresh"]')!.click();
    await waitFor(() => vi.mocked(files.listDir).mock.calls.length > before);
    expect(vi.mocked(files.listDir).mock.calls.length).toBeGreaterThan(before);
  });

  it('switching back to the outline tab restores the outline', async () => {
    const { host } = await showFilesTab();
    host.querySelector<HTMLButtonElement>('.lp-tab[data-tab="outline"]')!.click();
    expect(host.querySelector('.lp-item')).not.toBeNull();
    expect(host.querySelector('.ft-tree')).toBeNull();
  });
});
