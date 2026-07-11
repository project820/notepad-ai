import type { OverviewDraft, OverviewFrontmatter } from './types';

const SYSTEM_KEYS = new Set([
  'overview_version',
  'scope',
  'status',
  'created_by',
  'created_at',
  'last_modified',
  'last_reviewed',
  'last_scanned',
  'timezone',
  'inherits',
  'confidence',
  'user_metadata',
]);

type RepairInput = {
  body: string;
  frontmatter: Record<string, unknown>;
  now: string;
  createdAtFallback: string;
  lastScanned: string | null;
  inherits: boolean;
};

function scalarYaml(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  return String(value).includes(': ') ? JSON.stringify(String(value)) : String(value);
}

export function repairOverviewDraft(input: RepairInput): OverviewDraft {
  const existingUserMetadata =
    input.frontmatter.user_metadata && typeof input.frontmatter.user_metadata === 'object'
      ? { ...(input.frontmatter.user_metadata as Record<string, unknown>) }
      : {};

  const unknown: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input.frontmatter)) {
    if (!SYSTEM_KEYS.has(key)) unknown[key] = value;
  }

  const createdAt =
    typeof input.frontmatter.created_at === 'string' && input.frontmatter.created_at.trim()
      ? input.frontmatter.created_at
      : input.createdAtFallback;

  const frontmatter: OverviewFrontmatter = {
    overview_version: 1,
    scope: 'folder',
    status: 'active',
    created_by: 'notepad-ai',
    created_at: createdAt,
    last_modified: input.now,
    last_reviewed: typeof input.frontmatter.last_reviewed === 'string' ? input.frontmatter.last_reviewed : null,
    last_scanned: input.lastScanned,
    timezone: 'Asia/Seoul',
    inherits: input.inherits,
    confidence: input.frontmatter.confidence === 'reviewed' ? 'reviewed' : 'draft',
    user_metadata: { ...existingUserMetadata, ...unknown },
  };

  return { frontmatter, body: input.body ?? '' };
}

export function renderOverviewMarkdown(draft: OverviewDraft): string {
  const fm = draft.frontmatter;
  const lines = [
    '---',
    `overview_version: ${fm.overview_version}`,
    `scope: ${fm.scope}`,
    `status: ${fm.status}`,
    `created_by: ${fm.created_by}`,
    `created_at: ${fm.created_at}`,
    `last_modified: ${fm.last_modified}`,
    `last_reviewed: ${scalarYaml(fm.last_reviewed)}`,
    `last_scanned: ${scalarYaml(fm.last_scanned)}`,
    `timezone: ${fm.timezone}`,
    `inherits: ${fm.inherits}`,
    `confidence: ${fm.confidence}`,
  ];

  if (Object.keys(fm.user_metadata).length > 0) {
    lines.push('user_metadata:');
    for (const [key, value] of Object.entries(fm.user_metadata)) {
      lines.push(`  ${key}: ${scalarYaml(value)}`);
    }
  } else {
    lines.push('user_metadata: {}');
  }

  lines.push('---', '', '# Overview', '', '');
  const body = draft.body.trim();
  return `${lines.join('\n')}${body ? `${body}\n` : defaultOverviewBody()}`;
}

function defaultOverviewBody(): string {
  return [
    '## Purpose',
    '',
    '## Background',
    '',
    '## Current Goals',
    '',
    '## Writing Rules',
    '',
    '## Key Entities',
    '',
    '## Source Map',
    '',
    '| File | Role | Notes |',
    '|---|---|---|',
    '',
    '## Open Questions',
    '',
    '## Context Inbox Notes',
    '',
    '## Do Not Assume',
    '',
  ].join('\n');
}
