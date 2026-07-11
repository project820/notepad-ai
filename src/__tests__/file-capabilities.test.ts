/**
 * file-capabilities.test.ts — per-window filesystem grant authority (Phase 1).
 *
 * Proves the renderer can only read/list/write/open paths the user actually
 * granted (workspace root, dialog/open/save/restore file), and that an arbitrary
 * absolute path or a symlink-style escape outside a granted root is denied.
 */

import { describe, it, expect } from 'vitest';
import { FileGrants } from '../main/file-grants';

const WC = 7;

describe('FileGrants — workspace grants', () => {
  it('allows listing only a granted workspace root', () => {
    const g = new FileGrants();
    expect(g.isWorkspaceGranted(WC, '/Users/me/proj')).toBe(false);
    g.grantWorkspace(WC, '/Users/me/proj');
    expect(g.isWorkspaceGranted(WC, '/Users/me/proj')).toBe(true);
    // The attacker's "list the whole disk" root is not granted.
    expect(g.isWorkspaceGranted(WC, '/')).toBe(false);
    expect(g.isWorkspaceGranted(WC, '/Users')).toBe(false);
  });

  it('normalizes the root so . segments do not defeat the grant check', () => {
    const g = new FileGrants();
    g.grantWorkspace(WC, '/Users/me/proj');
    expect(g.isWorkspaceGranted(WC, '/Users/me/./proj')).toBe(true);
  });
});

describe('FileGrants — file authority', () => {
  it('denies an arbitrary absolute path with no grant', () => {
    const g = new FileGrants();
    expect(g.isFileAllowed(WC, '/Users/victim/.ssh/id_ed25519')).toBe(false);
    expect(g.isFileAllowed(WC, '/Users/victim/.zshrc')).toBe(false);
  });

  it('allows a directly granted file (dialog/open/save/restore)', () => {
    const g = new FileGrants();
    g.grantFile(WC, '/Users/me/notes/a.md');
    expect(g.isFileAllowed(WC, '/Users/me/notes/a.md')).toBe(true);
    expect(g.isFileAllowed(WC, '/Users/me/notes/b.md')).toBe(false);
  });
  it('does not promote a directly granted file parent into a project wizard root', () => {
    const g = new FileGrants();
    g.grantFile(WC, '/Users/me/notes/a.md');

    expect(g.projectWizardRoots(WC)).toEqual([]);
  });

  it('allows files inside a granted workspace root, denies escapes', () => {
    const g = new FileGrants();
    g.grantWorkspace(WC, '/Users/me/proj');
    expect(g.isFileAllowed(WC, '/Users/me/proj/docs/x.md')).toBe(true);
    expect(g.isFileAllowed(WC, '/Users/me/proj')).toBe(true);
    // A traversal escape out of the granted root is denied.
    expect(g.isFileAllowed(WC, '/Users/me/proj/../secret.md')).toBe(false);
    expect(g.isFileAllowed(WC, '/Users/me/other/x.md')).toBe(false);
  });

  it('scopes grants per window (no cross-window leakage)', () => {
    const g = new FileGrants();
    g.grantWorkspace(WC, '/Users/me/proj');
    g.grantFile(WC, '/Users/me/a.md');
    const OTHER = 9;
    expect(g.isWorkspaceGranted(OTHER, '/Users/me/proj')).toBe(false);
    expect(g.isFileAllowed(OTHER, '/Users/me/a.md')).toBe(false);
    expect(g.isFileAllowed(OTHER, '/Users/me/proj/x.md')).toBe(false);
  });

  it('release drops every grant for a closed window', () => {
    const g = new FileGrants();
    g.grantWorkspace(WC, '/Users/me/proj');
    g.grantFile(WC, '/Users/me/a.md');
    g.release(WC);
    expect(g.isWorkspaceGranted(WC, '/Users/me/proj')).toBe(false);
    expect(g.isFileAllowed(WC, '/Users/me/a.md')).toBe(false);
    expect(g.isFileAllowed(WC, '/Users/me/proj/x.md')).toBe(false);
  });
});
