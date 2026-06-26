/**
 * path-identity.test.ts — canonical identity + symlink-escape guard + keyed mutex (Phase 2).
 */

import { describe, it, expect } from 'vitest';
import {
  canonicalIdentity,
  canonicalNewTarget,
  isRealpathWithinRoot,
  type IdentityFs,
} from '../main/path-identity';
import { KeyedMutex } from '../main/keyed-mutex';

/** Fake fs: a symlink/realpath map + an inode table. */
function makeFs(opts: {
  links?: Record<string, string>;
  inodes?: Record<string, { dev: number; ino: number }>;
  missing?: string[];
}): IdentityFs {
  const links = opts.links ?? {};
  const inodes = opts.inodes ?? {};
  const missing = new Set(opts.missing ?? []);
  return {
    async realpath(p) {
      if (missing.has(p)) throw new Error(`ENOENT: ${p}`);
      return links[p] ?? p;
    },
    async stat(p) {
      const i = inodes[p];
      if (!i) throw new Error(`ENOENT stat: ${p}`);
      return i;
    },
  };
}

describe('canonicalIdentity', () => {
  it('resolves realpath + dev:ino for an existing file', async () => {
    const fs = makeFs({
      links: { '/w/./a.md': '/w/a.md' },
      inodes: { '/w/a.md': { dev: 1, ino: 42 } },
    });
    const id = await canonicalIdentity('/w/./a.md', fs);
    expect(id).toEqual({ realpath: '/w/a.md', identity: '1:42' });
  });

  it('gives two textual paths to one file the SAME identity (dedupe)', async () => {
    const fs = makeFs({
      links: { '/w/a.md': '/real/a.md', '/w/link-to-a.md': '/real/a.md' },
      inodes: { '/real/a.md': { dev: 1, ino: 7 } },
    });
    const a = await canonicalIdentity('/w/a.md', fs);
    const b = await canonicalIdentity('/w/link-to-a.md', fs);
    expect(a?.identity).toBe(b?.identity);
  });

  it('returns null for a missing/unresolvable path', async () => {
    const fs = makeFs({ missing: ['/nope'] });
    expect(await canonicalIdentity('/nope', fs)).toBeNull();
  });
});

describe('canonicalNewTarget', () => {
  it('realpaths the parent and rejoins the basename for a new file', async () => {
    const fs = makeFs({ links: { '/w/sub': '/real/sub' } });
    expect(await canonicalNewTarget('/w/sub/new.md', fs)).toBe('/real/sub/new.md');
  });
  it('returns null when the parent is unresolvable', async () => {
    const fs = makeFs({ missing: ['/w/gone'] });
    expect(await canonicalNewTarget('/w/gone/new.md', fs)).toBeNull();
  });
});

describe('isRealpathWithinRoot — symlink escape', () => {
  it('accepts a real descendant of the root', async () => {
    const fs = makeFs({ links: { '/root': '/root', '/root/docs/x.md': '/root/docs/x.md' } });
    expect(await isRealpathWithinRoot('/root', '/root/docs/x.md', fs)).toBe(true);
  });
  it('rejects a symlink inside the root whose real target escapes it', async () => {
    const fs = makeFs({ links: { '/root': '/root', '/root/evil': '/etc/secret' } });
    expect(await isRealpathWithinRoot('/root', '/root/evil', fs)).toBe(false);
  });
  it('accepts the root itself', async () => {
    const fs = makeFs({ links: { '/root': '/root' } });
    expect(await isRealpathWithinRoot('/root', '/root', fs)).toBe(true);
  });
});

describe('KeyedMutex', () => {
  it('serializes same-key runs in arrival order; no overlap', async () => {
    const m = new KeyedMutex();
    const events: string[] = [];
    const make = (id: string) => async () => {
      events.push(`${id}:start`);
      await new Promise((r) => setTimeout(r, 10));
      events.push(`${id}:end`);
    };
    await Promise.all([m.run('k', make('A')), m.run('k', make('B'))]);
    expect(events).toEqual(['A:start', 'A:end', 'B:start', 'B:end']);
  });

  it('runs different keys concurrently', async () => {
    const m = new KeyedMutex();
    const order: string[] = [];
    await Promise.all([
      m.run('k1', async () => {
        await new Promise((r) => setTimeout(r, 20));
        order.push('k1');
      }),
      m.run('k2', async () => {
        order.push('k2');
      }),
    ]);
    expect(order[0]).toBe('k2'); // k2 not blocked by k1
  });

  it('releases the lock when fn rejects (next run still proceeds)', async () => {
    const m = new KeyedMutex();
    await expect(m.run('k', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    const ok = await m.run('k', async () => 'ok');
    expect(ok).toBe('ok');
  });

  it('drains active keys back to zero once idle', async () => {
    const m = new KeyedMutex();
    await m.run('k', async () => undefined);
    await new Promise((r) => setTimeout(r, 0));
    expect(m.activeKeys).toBe(0);
  });
});
