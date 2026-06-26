/**
 * session-schema.test.ts
 *
 * Pure unit tests for the v0.3 session migration helpers (G001). No Electron, no
 * fs — the schema module is deliberately dependency-free.
 *
 * Coverage:
 *   - legacy single snapshot → v2 one-window migration
 *   - already-v2 normalized passthrough
 *   - malformed / null inputs → safe empty aggregate
 *   - upsertWindowSnapshot (replace + append)
 *   - removeWindowSnapshot
 *   - input immutability (migrate / upsert / remove never mutate their args)
 */

import { describe, it, expect } from 'vitest';
import {
  migrateSessionSnapshot,
  upsertWindowSnapshot,
  removeWindowSnapshot,
  LEGACY_WINDOW_ID,
  type SessionSnapshotV2,
  type SessionWindowSnapshot,
} from '../../src/main/session-schema';

function v2(windows: SessionWindowSnapshot[], cleanExit?: boolean): SessionSnapshotV2 {
  const state: SessionSnapshotV2 = { version: 2, windows };
  if (cleanExit !== undefined) state.cleanExit = cleanExit;
  return state;
}

function win(id: string, over: Partial<SessionWindowSnapshot> = {}): SessionWindowSnapshot {
  return { id, path: null, title: null, doc: '', ...over };
}

// ============================================================================
// A. Legacy → v2 (single-window migration)
// ============================================================================

describe('migrateSessionSnapshot — legacy → v2', () => {
  it('wraps a legacy single snapshot into exactly one window', () => {
    const legacy = {
      savedAt: 1700,
      doc: '# Hello',
      currentPath: '/Users/me/a.md',
      pendingTitle: 'a.md',
      splitRatio: 0.4,
      viewMode: 'split' as const,
      chatHistory: [{ role: 'user' as const, text: 'hi' }],
      model: 'gpt-x',
      cleanExit: true,
    };

    const out = migrateSessionSnapshot(legacy);

    expect(out.version).toBe(2);
    expect(out.windows).toHaveLength(1);
    expect(out.cleanExit).toBe(true);

    const w = out.windows[0];
    expect(w.id).toBe(LEGACY_WINDOW_ID);
    expect(w.doc).toBe('# Hello');
    expect(w.path).toBe('/Users/me/a.md'); // currentPath → path
    expect(w.title).toBe('a.md'); // pendingTitle → title
    expect(w.view).toBe('split'); // viewMode → view
    expect(w.splitRatio).toBe(0.4);
    expect(w.model).toBe('gpt-x');
    expect(w.savedAt).toBe(1700);
    expect(w.chatHistory).toEqual([{ role: 'user', text: 'hi' }]);
  });

  it('defaults missing legacy fields to safe values (still one window)', () => {
    const out = migrateSessionSnapshot({ doc: 'only-doc' });

    expect(out.version).toBe(2);
    expect(out.windows).toHaveLength(1);
    const w = out.windows[0];
    expect(w.id).toBe(LEGACY_WINDOW_ID);
    expect(w.doc).toBe('only-doc');
    expect(w.path).toBeNull();
    expect(w.title).toBeNull();
    expect(w.cleanExit).toBeUndefined();
  });

  it('never copies auth-like fields onto the window (security)', () => {
    const out = migrateSessionSnapshot({ doc: 'x', token: 'secret', apiKey: 'k' } as Record<string, unknown>);
    const w = out.windows[0] as Record<string, unknown>;
    expect(w.token).toBeUndefined();
    expect(w.apiKey).toBeUndefined();
  });
});

// ============================================================================
// B. Already-v2 passthrough (normalized)
// ============================================================================

describe('migrateSessionSnapshot — v2 passthrough', () => {
  it('preserves a well-formed v2 aggregate with multiple windows', () => {
    const input = v2([win('w1', { doc: 'one' }), win('w2', { doc: 'two', dirty: true })], false);

    const out = migrateSessionSnapshot(input);

    expect(out.version).toBe(2);
    expect(out.windows).toHaveLength(2);
    expect(out.windows.map((w) => w.id)).toEqual(['w1', 'w2']);
    expect(out.windows[1].dirty).toBe(true);
    expect(out.cleanExit).toBe(false);
  });

  it('drops malformed windows (no usable id) during normalization', () => {
    const input = {
      version: 2,
      windows: [win('keep'), { doc: 'no-id' }, null, 42, { id: '' }],
    };

    const out = migrateSessionSnapshot(input);

    expect(out.windows).toHaveLength(1);
    expect(out.windows[0].id).toBe('keep');
  });

  it('coerces a missing windows array to an empty list', () => {
    const out = migrateSessionSnapshot({ version: 2 });
    expect(out).toEqual({ version: 2, windows: [] });
  });
});

// ============================================================================
// C. Malformed / null → safe empty
// ============================================================================

describe('migrateSessionSnapshot — malformed / null', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['number', 42],
    ['string', 'nope'],
    ['boolean', true],
    ['array', [{ id: 'x' }]],
  ])('returns the safe empty aggregate for %s', (_label, value) => {
    expect(migrateSessionSnapshot(value)).toEqual({ version: 2, windows: [] });
  });

  it('returns a fresh object each time (no shared mutable default)', () => {
    const a = migrateSessionSnapshot(null);
    const b = migrateSessionSnapshot(null);
    expect(a).not.toBe(b);
    expect(a.windows).not.toBe(b.windows);
  });

  it('rejects a FUTURE version (>2) as unreadable instead of legacy-wrapping it (M-04)', () => {
    const future = { version: 3, windows: [{ id: 'w1', doc: 'hi' }], somethingNew: true };
    // Must NOT be coerced into a one-window legacy aggregate (which would clobber
    // a newer on-disk format); it is treated as unreadable → safe empty.
    expect(migrateSessionSnapshot(future)).toEqual({ version: 2, windows: [] });
  });

  it('still wraps a genuine legacy snapshot (no version field) into one window', () => {
    const out = migrateSessionSnapshot({ doc: 'legacy body', currentPath: '/a.md' });
    expect(out.version).toBe(2);
    expect(out.windows).toHaveLength(1);
  });
});

// ============================================================================
// D. upsertWindowSnapshot
// ============================================================================

describe('upsertWindowSnapshot', () => {
  it('appends a window with a new id', () => {
    const state = v2([win('a', { doc: 'a' })]);
    const out = upsertWindowSnapshot(state, win('b', { doc: 'b' }));

    expect(out.windows.map((w) => w.id)).toEqual(['a', 'b']);
    expect(out.windows[1].doc).toBe('b');
  });

  it('replaces the window with a matching id (no duplicate)', () => {
    const state = v2([win('a', { doc: 'old' }), win('b', { doc: 'b' })]);
    const out = upsertWindowSnapshot(state, win('a', { doc: 'new' }));

    expect(out.windows).toHaveLength(2);
    expect(out.windows[0].id).toBe('a');
    expect(out.windows[0].doc).toBe('new');
    expect(out.windows[1].id).toBe('b'); // order preserved
  });

  it('preserves the top-level cleanExit flag', () => {
    const state = v2([win('a')], true);
    const out = upsertWindowSnapshot(state, win('b'));
    expect(out.cleanExit).toBe(true);
  });
});

// ============================================================================
// E. removeWindowSnapshot
// ============================================================================

describe('removeWindowSnapshot', () => {
  it('removes the window with the given id', () => {
    const state = v2([win('a'), win('b'), win('c')]);
    const out = removeWindowSnapshot(state, 'b');
    expect(out.windows.map((w) => w.id)).toEqual(['a', 'c']);
  });

  it('is a no-op for an unknown id (but still returns a new object)', () => {
    const state = v2([win('a')]);
    const out = removeWindowSnapshot(state, 'zzz');
    expect(out.windows.map((w) => w.id)).toEqual(['a']);
    expect(out).not.toBe(state);
  });
});

// ============================================================================
// F. Input immutability
// ============================================================================

describe('input immutability', () => {
  it('migrate does not mutate the legacy input (incl. nested arrays)', () => {
    const legacy = { doc: 'hi', currentPath: '/a.md', chatHistory: [{ role: 'user' as const, text: 'x' }] };
    const out = migrateSessionSnapshot(legacy);

    out.windows[0].doc = 'changed';
    out.windows[0].chatHistory!.push({ role: 'assistant', text: 'y' });

    expect(legacy.doc).toBe('hi');
    expect(legacy.chatHistory).toHaveLength(1);
  });

  it('upsert returns a new state/array and leaves the input untouched', () => {
    const state = v2([win('a')]);
    const out = upsertWindowSnapshot(state, win('b'));

    expect(out).not.toBe(state);
    expect(out.windows).not.toBe(state.windows);
    expect(state.windows.map((w) => w.id)).toEqual(['a']); // unchanged
  });

  it('remove returns a new state/array and leaves the input untouched', () => {
    const state = v2([win('a'), win('b')]);
    const out = removeWindowSnapshot(state, 'a');

    expect(out).not.toBe(state);
    expect(out.windows).not.toBe(state.windows);
    expect(state.windows.map((w) => w.id)).toEqual(['a', 'b']); // unchanged
  });
});
