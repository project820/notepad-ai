import { describe, it, expect } from 'vitest';
import { repairOverviewDraft, renderOverviewMarkdown } from '../main/project-wizard/overview-template';

describe('repairOverviewDraft', () => {
  it('canonicalizes system fields and moves unknown frontmatter into user_metadata', () => {
    const draft = repairOverviewDraft({
      body: '## Purpose\nProject context.',
      frontmatter: {
        overview_version: 99,
        random_key: 'keep me',
        user_metadata: { existing: 'value' },
      },
      now: '2026-05-15T14:40:32+09:00',
      createdAtFallback: '2026-05-15T14:00:00+09:00',
      lastScanned: '2026-05-15T14:30:00+09:00',
      inherits: true,
    });

    expect(draft.frontmatter.overview_version).toBe(1);
    expect(draft.frontmatter.created_by).toBe('notepad-ai');
    expect(draft.frontmatter.last_modified).toBe('2026-05-15T14:40:32+09:00');
    expect(draft.frontmatter.timezone).toBe('Asia/Seoul');
    expect(draft.frontmatter.user_metadata).toEqual({
      existing: 'value',
      random_key: 'keep me',
    });
  });

  it('renders required Overview sections', () => {
    const md = renderOverviewMarkdown({
      frontmatter: repairOverviewDraft({
        body: '## Purpose\nProject context.',
        frontmatter: {},
        now: '2026-05-15T14:40:32+09:00',
        createdAtFallback: '2026-05-15T14:00:00+09:00',
        lastScanned: null,
        inherits: true,
      }).frontmatter,
      body: '## Purpose\nProject context.',
    });

    expect(md).toContain('overview_version: 1');
    expect(md).toContain('last_modified: 2026-05-15T14:40:32+09:00');
    expect(md).toContain('## Purpose');
    expect(md).toContain('# Overview\n\n## Purpose');
  });
});
