/**
 * overview-traversal.test.ts
 *
 * Unit tests for findOverviewChain and findOverviewPaths.
 * Uses Node.js built-in test runner (node:test + node:assert/strict).
 * Run with:  node --test dist/main/overview-traversal.test.js
 *
 * Test matrix (per Sub-AC 12.1):
 *  1. No Overview.md found anywhere in the workspace
 *  2. Overview.md only at the document's immediate parent directory
 *  3. Overview.md only at a higher ancestor directory
 *  4. Multiple Overview.md files at different ancestor levels — closest-first ordering
 *  5. Workspace-root boundary is honoured (traversal stops at root, never goes above)
 *  6. Document is at the workspace root level (depth 0 case)
 *  7. Document is outside the workspace — returns [] immediately
 *  8. Three-level nesting with Overview.md at every level
 *  9. Directory named "Overview.md" is NOT treated as a match (must be a file)
 * 10. findOverviewPaths returns only paths (no depth metadata)
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { findOverviewChain, findOverviewPaths } from './overview-traversal';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Creates an isolated temporary directory for one test scenario. */
async function makeTmp(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'notepad-ai-ov-'));
}

/** Removes a temporary directory tree unconditionally. */
async function removeTmp(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}

/** Creates a file (and any missing parent directories) with given content. */
async function touch(filePath: string, content = '# placeholder'): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf-8');
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('findOverviewChain', () => {

  // ── Case 1: No Overview.md exists anywhere ──────────────────────────────
  test('returns [] when no Overview.md exists in the workspace', async () => {
    const root = await makeTmp();
    try {
      // root/
      //   sub/
      //     doc.md   ← no Overview.md anywhere
      const filePath = path.join(root, 'sub', 'doc.md');
      await touch(filePath);

      const result = await findOverviewChain(filePath, root);
      assert.deepEqual(result, []);
    } finally {
      await removeTmp(root);
    }
  });

  // ── Case 2: Overview.md at the document's immediate parent ───────────────
  test('finds Overview.md only at immediate parent directory (depth 0)', async () => {
    const root = await makeTmp();
    try {
      // root/
      //   Overview.md
      //   doc.md        ← file is at root level; parent = root
      const overviewPath = path.join(root, 'Overview.md');
      await touch(overviewPath, '# Root overview');
      const filePath = path.join(root, 'doc.md');
      await touch(filePath);

      const result = await findOverviewChain(filePath, root);
      assert.equal(result.length, 1);
      assert.equal(result[0].filePath, overviewPath);
      assert.equal(result[0].depth, 0);
    } finally {
      await removeTmp(root);
    }
  });

  // ── Case 3: Overview.md at a higher ancestor, not in immediate parent ────
  test('finds Overview.md only at an ancestor level (depth > 0)', async () => {
    const root = await makeTmp();
    try {
      // root/
      //   Overview.md      ← only here
      //   a/
      //     b/
      //       doc.md       ← no Overview.md in a/ or a/b/
      const overviewPath = path.join(root, 'Overview.md');
      await touch(overviewPath, '# Root overview');
      const filePath = path.join(root, 'a', 'b', 'doc.md');
      await touch(filePath);

      const result = await findOverviewChain(filePath, root);
      assert.equal(result.length, 1);
      assert.equal(result[0].filePath, overviewPath);
      assert.equal(result[0].depth, 2); // b(0→skip), a(1→skip), root(2→hit)
    } finally {
      await removeTmp(root);
    }
  });

  // ── Case 4: Multiple Overview.md files — closest first ──────────────────
  test('returns multiple Overview.md files ordered closest-first', async () => {
    const root = await makeTmp();
    try {
      // root/
      //   Overview.md        ← depth 2
      //   a/
      //     Overview.md      ← depth 1
      //     b/
      //       doc.md         ← no Overview.md in b/
      const rootOverview = path.join(root, 'Overview.md');
      await touch(rootOverview, '# Root');
      const aOverview = path.join(root, 'a', 'Overview.md');
      await touch(aOverview, '# A');
      const filePath = path.join(root, 'a', 'b', 'doc.md');
      await touch(filePath);

      const result = await findOverviewChain(filePath, root);
      assert.equal(result.length, 2);
      // Closest first: a/ (depth 1) then root (depth 2)
      assert.equal(result[0].filePath, aOverview);
      assert.equal(result[0].depth, 1);
      assert.equal(result[1].filePath, rootOverview);
      assert.equal(result[1].depth, 2);
    } finally {
      await removeTmp(root);
    }
  });

  // ── Case 5: Workspace-root boundary stop ────────────────────────────────
  test('stops traversal at workspaceRoot and does not go above it', async () => {
    const root = await makeTmp();
    try {
      // root/
      //   sub/
      //     doc.md
      // (nothing above root is checked — we cannot easily create files in
      //  os.tmpdir() parent, but we verify the boundary by checking that
      //  a file in root's grandparent (if it existed) would NOT be returned)
      //
      // Simpler verification: place Overview.md ONLY at root and confirm it
      // IS found (root is inclusive) but traversal did not go higher.
      const rootOverview = path.join(root, 'Overview.md');
      await touch(rootOverview, '# Root');
      const filePath = path.join(root, 'sub', 'doc.md');
      await touch(filePath);

      const result = await findOverviewChain(filePath, root);
      // Only the root-level Overview.md should appear.
      assert.equal(result.length, 1);
      assert.equal(result[0].filePath, rootOverview);
      assert.equal(result[0].depth, 1);

      // None of the paths should go outside `root`.
      for (const entry of result) {
        assert.ok(
          entry.filePath.startsWith(root),
          `Path ${entry.filePath} escapes workspace root ${root}`,
        );
      }
    } finally {
      await removeTmp(root);
    }
  });

  // ── Case 6: Document is at the workspace root level ──────────────────────
  test('handles a document that lives directly inside the workspace root', async () => {
    const root = await makeTmp();
    try {
      // root/
      //   Overview.md
      //   notes.md      ← document AT root level
      const overviewPath = path.join(root, 'Overview.md');
      await touch(overviewPath, '# Root overview');
      const filePath = path.join(root, 'notes.md');
      await touch(filePath);

      const result = await findOverviewChain(filePath, root);
      assert.equal(result.length, 1);
      assert.equal(result[0].filePath, overviewPath);
      assert.equal(result[0].depth, 0);
    } finally {
      await removeTmp(root);
    }
  });

  // ── Case 7: Document is OUTSIDE the workspace ────────────────────────────
  test('returns [] immediately when document is outside the workspace root', async () => {
    const root = await makeTmp();
    const outsideDir = await makeTmp(); // a completely separate tmpdir
    try {
      // Put an Overview.md inside root — it must NOT be returned.
      await touch(path.join(root, 'Overview.md'), '# Root overview');
      // Document lives in outsideDir, which is not a descendant of root.
      const filePath = path.join(outsideDir, 'doc.md');
      await touch(filePath);

      const result = await findOverviewChain(filePath, root);
      assert.deepEqual(result, []);
    } finally {
      await removeTmp(root);
      await removeTmp(outsideDir);
    }
  });

  // ── Case 8: Three-level nesting with Overview.md at every level ──────────
  test('returns all Overview.md files when present at every ancestor level', async () => {
    const root = await makeTmp();
    try {
      // root/
      //   Overview.md     ← depth 3
      //   a/
      //     Overview.md   ← depth 2
      //     b/
      //       Overview.md ← depth 1
      //       c/
      //         doc.md    ← depth 0 (c/ has no Overview.md)
      const rootOverview = path.join(root, 'Overview.md');
      await touch(rootOverview, '# Root');
      const aOverview = path.join(root, 'a', 'Overview.md');
      await touch(aOverview, '# A');
      const bOverview = path.join(root, 'a', 'b', 'Overview.md');
      await touch(bOverview, '# B');
      const filePath = path.join(root, 'a', 'b', 'c', 'doc.md');
      await touch(filePath);

      const result = await findOverviewChain(filePath, root);
      assert.equal(result.length, 3);
      assert.equal(result[0].filePath, bOverview);  // closest
      assert.equal(result[0].depth, 1);
      assert.equal(result[1].filePath, aOverview);
      assert.equal(result[1].depth, 2);
      assert.equal(result[2].filePath, rootOverview);  // farthest
      assert.equal(result[2].depth, 3);
    } finally {
      await removeTmp(root);
    }
  });

  // ── Case 9: Directory named "Overview.md" is NOT a match ─────────────────
  test('ignores a directory named Overview.md (only regular files count)', async () => {
    const root = await makeTmp();
    try {
      // root/
      //   Overview.md/   ← it's a DIRECTORY, not a file
      //   doc.md
      const fakePath = path.join(root, 'Overview.md');
      await fs.mkdir(fakePath, { recursive: true }); // create as directory
      const filePath = path.join(root, 'doc.md');
      await touch(filePath);

      const result = await findOverviewChain(filePath, root);
      assert.deepEqual(result, []); // directory must be skipped
    } finally {
      await removeTmp(root);
    }
  });

  // ── Case 10: findOverviewPaths convenience wrapper ────────────────────────
  test('findOverviewPaths returns flat path list without depth metadata', async (t) => {
    const root = await makeTmp();
    try {
      const rootOverview = path.join(root, 'Overview.md');
      await touch(rootOverview, '# Root');
      const subOverview = path.join(root, 'sub', 'Overview.md');
      await touch(subOverview, '# Sub');
      const filePath = path.join(root, 'sub', 'doc.md');
      await touch(filePath);

      const paths = await findOverviewPaths(filePath, root);
      assert.deepEqual(paths, [subOverview, rootOverview]);

      // Verify it's an array of strings (no depth property)
      assert.equal(typeof paths[0], 'string');
    } finally {
      await removeTmp(root);
    }
  });

});

// ---------------------------------------------------------------------------
// Edge-case regression tests outside the main describe block
// ---------------------------------------------------------------------------

test('handles paths with trailing slashes on workspaceRoot gracefully', async () => {
  const root = await makeTmp();
  try {
    const overviewPath = path.join(root, 'Overview.md');
    await touch(overviewPath, '# Root');
    const filePath = path.join(root, 'doc.md');
    await touch(filePath);

    // path.resolve normalises trailing slashes, so this must work identically
    const resultWithSlash = await findOverviewPaths(filePath, root + '/');
    const resultWithout  = await findOverviewPaths(filePath, root);
    assert.deepEqual(resultWithSlash, resultWithout);
  } finally {
    await removeTmp(root);
  }
});

test('workspaceRoot that is the same directory as the document', async () => {
  const root = await makeTmp();
  try {
    const overviewPath = path.join(root, 'Overview.md');
    await touch(overviewPath, '# Root');
    const filePath = path.join(root, 'doc.md');
    await touch(filePath);

    // workspaceRoot == dirname(filePath)
    const result = await findOverviewChain(filePath, root);
    assert.equal(result.length, 1);
    assert.equal(result[0].filePath, overviewPath);
    assert.equal(result[0].depth, 0);
  } finally {
    await removeTmp(root);
  }
});
