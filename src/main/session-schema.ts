/**
 * Session schema (v2) + pure migration helpers.
 *
 * v0.3 multi-window groundwork (G001). The persisted session moves from a single
 * legacy snapshot to a versioned aggregate `{ version: 2, windows: [...] }` so the
 * crash/quit restore path can rebuild a *set* of windows instead of one document.
 *
 * This module is intentionally PURE: no Electron / `node:fs` imports, so every
 * helper is unit-testable in a plain Node environment. The runtime wiring (read +
 * migrate on launch, atomic write) lives in `session-store.ts`.
 *
 * SECURITY: snapshots NEVER carry auth tokens or API keys — not even in the types.
 * Auth lives in the OS keychain / provider registry, never in `session.json`.
 */

/** A single chat message persisted with a window (mirrors the legacy payload). */
type SessionChatMessage = { role: 'user' | 'assistant'; text: string };

/** v1 unified collaborator-chat entry (messages + legacy separators). */
type SessionUnifiedChatEntry =
  | { type: 'message'; role: 'user' | 'assistant'; text: string; legacySource?: 'bottom' | 'side' }
  | { type: 'separator'; label: string };

type SessionViewMode = 'split' | 'editor-only' | 'preview-only';


/** One window's document state inside the v2 aggregate. */
export type SessionWindowSnapshot = {
  /** Stable, renderer-owned window id. Required — windows without one are dropped. */
  id: string;
  path: string | null;
  title: string | null;
  doc: string;
  savedAt?: number;
  splitRatio?: number;
  view?: SessionViewMode;
  chatHistory?: SessionChatMessage[];
  unifiedChatHistory?: SessionUnifiedChatEntry[];
  model?: string;
  dirty?: boolean;
};

/** The versioned multi-window aggregate persisted from v0.3 onward. */
export type SessionSnapshotV2 = {
  version: 2;
  windows: SessionWindowSnapshot[];
  cleanExit?: boolean;
  restoreReason?: 'shutdown';
};
export function isRestorableSessionWindow(snapshot: Pick<SessionWindowSnapshot, 'doc' | 'unifiedChatHistory'>): boolean {
  return (snapshot.doc?.length ?? 0) > 0 || (snapshot.unifiedChatHistory?.length ?? 0) > 0;
}

export function normalizeWindowSnapshot(
  id: string,
  currentPath: string | null | undefined,
  raw: unknown,
): SessionWindowSnapshot {
  const r = isRecord(raw) ? raw : {};
  const win: SessionWindowSnapshot = {
    id,
    path: currentPath ?? null,
    title: typeof r.title === 'string' ? r.title : null,
    doc: typeof r.doc === 'string' ? r.doc : '',
  };
  if (typeof r.savedAt === 'number') win.savedAt = r.savedAt;
  if (typeof r.splitRatio === 'number') win.splitRatio = r.splitRatio;
  const view = asViewMode(r.view);
  if (view) win.view = view;
  const chat = cloneArray<SessionChatMessage>(r.chatHistory);
  if (chat) win.chatHistory = chat;
  const unified = cloneArray<SessionUnifiedChatEntry>(r.unifiedChatHistory);
  if (unified) win.unifiedChatHistory = unified;
  if (typeof r.model === 'string') win.model = r.model;
  if (typeof r.dirty === 'boolean') win.dirty = r.dirty;
  return win;
}

/** Deterministic id assigned to the single window produced by a legacy migration. */
export const LEGACY_WINDOW_ID = 'legacy';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asViewMode(value: unknown): SessionViewMode | undefined {
  return value === 'split' || value === 'editor-only' || value === 'preview-only' ? value : undefined;
}

/** Shallow-copy each array element so the result never shares mutable refs with `raw`. */
function cloneArray<T>(value: unknown): T[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((entry) => (isRecord(entry) ? ({ ...entry } as T) : (entry as T)));
}

/** Normalize one persisted window object; returns null when it lacks a usable id. */
function normalizeWindow(raw: unknown): SessionWindowSnapshot | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.id !== 'string' || raw.id.length === 0) return null;

  const win: SessionWindowSnapshot = {
    id: raw.id,
    path: typeof raw.path === 'string' ? raw.path : null,
    title: typeof raw.title === 'string' ? raw.title : null,
    doc: typeof raw.doc === 'string' ? raw.doc : '',
  };
  if (typeof raw.savedAt === 'number') win.savedAt = raw.savedAt;
  if (typeof raw.splitRatio === 'number') win.splitRatio = raw.splitRatio;
  const view = asViewMode(raw.view);
  if (view) win.view = view;
  const chat = cloneArray<SessionChatMessage>(raw.chatHistory);
  if (chat) win.chatHistory = chat;
  const unified = cloneArray<SessionUnifiedChatEntry>(raw.unifiedChatHistory);
  if (unified) win.unifiedChatHistory = unified;
  if (typeof raw.model === 'string') win.model = raw.model;
  if (typeof raw.dirty === 'boolean') win.dirty = raw.dirty;
  return win;
}

/** Passthrough + normalize an already-v2 aggregate (drops malformed windows). */
function normalizeV2(raw: Record<string, unknown>): SessionSnapshotV2 {
  const rawWindows = Array.isArray(raw.windows) ? raw.windows : [];
  const windows: SessionWindowSnapshot[] = [];
  for (const entry of rawWindows) {
    const win = normalizeWindow(entry);
    if (win) windows.push(win);
  }
  const out: SessionSnapshotV2 = { version: 2, windows };
  if (typeof raw.cleanExit === 'boolean') out.cleanExit = raw.cleanExit;
  if (raw.restoreReason === 'shutdown') out.restoreReason = 'shutdown';
  return out;
}

/** Wrap a legacy single snapshot into a one-window v2 aggregate (no data loss). */
function legacyToV2(raw: Record<string, unknown>): SessionSnapshotV2 {
  const win: SessionWindowSnapshot = {
    id: LEGACY_WINDOW_ID,
    path: typeof raw.currentPath === 'string' ? raw.currentPath : null,
    title: typeof raw.pendingTitle === 'string' ? raw.pendingTitle : null,
    doc: typeof raw.doc === 'string' ? raw.doc : '',
  };
  if (typeof raw.savedAt === 'number') win.savedAt = raw.savedAt;
  if (typeof raw.splitRatio === 'number') win.splitRatio = raw.splitRatio;
  const view = asViewMode(raw.viewMode);
  if (view) win.view = view;
  const chat = cloneArray<SessionChatMessage>(raw.chatHistory);
  if (chat) win.chatHistory = chat;
  const unified = cloneArray<SessionUnifiedChatEntry>(raw.unifiedChatHistory);
  if (unified) win.unifiedChatHistory = unified;
  if (typeof raw.model === 'string') win.model = raw.model;

  const out: SessionSnapshotV2 = { version: 2, windows: [win] };
  if (typeof raw.cleanExit === 'boolean') out.cleanExit = raw.cleanExit;
  return out;
}

/**
 * Migrate any persisted session value into a v2 aggregate. Pure: the input is
 * never mutated and the result shares no mutable references with it.
 *
 * - already v2 → normalized passthrough (malformed windows dropped)
 * - legacy single snapshot (any other object) → wrapped into one window
 * - null / non-object / array (malformed) → safe empty `{ version: 2, windows: [] }`
 */
export function migrateSessionSnapshot(raw: unknown): SessionSnapshotV2 {
  if (!isRecord(raw)) return { version: 2, windows: [] };
  if (raw.version === 2) return normalizeV2(raw);
  // A future/unknown numeric version must NOT be coerced into a legacy single
  // snapshot (that would clobber a newer on-disk format written by a later app
  // build). Treat it as unreadable → safe empty aggregate (M-04).
  if (typeof raw.version === 'number') return { version: 2, windows: [] };
  // No `version` field → a genuine pre-v2 legacy single snapshot.
  return legacyToV2(raw);
}

/** Replace the window with the same id, or append it. Returns a new aggregate. */
export function upsertWindowSnapshot(
  state: SessionSnapshotV2,
  win: SessionWindowSnapshot,
): SessionSnapshotV2 {
  const windows = state.windows.slice();
  const idx = windows.findIndex((w) => w.id === win.id);
  if (idx >= 0) windows[idx] = win;
  else windows.push(win);
  return { ...state, windows };
}

/** Remove the window with the given id. Returns a new aggregate. */
export function removeWindowSnapshot(state: SessionSnapshotV2, id: string): SessionSnapshotV2 {
  return { ...state, windows: state.windows.filter((w) => w.id !== id) };
}
