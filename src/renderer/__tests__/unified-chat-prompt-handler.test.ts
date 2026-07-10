import { describe, expect, it } from 'vitest';

import {
  buildUnifiedChatInstructions,
  UNIFIED_CHAT_SURFACE_PROMPT,
} from '../unified-chat-prompt-handler';

describe('buildUnifiedChatInstructions', () => {
  it('includes the collaborator surface prompt and a document section', () => {
    const out = buildUnifiedChatInstructions({ documentText: 'hello' });
    expect(out).toContain(UNIFIED_CHAT_SURFACE_PROMPT);
    expect(out).toContain('=== Current document ===');
    expect(out).toContain('hello');
  });

  it('uses (empty) when no document text', () => {
    expect(buildUnifiedChatInstructions({})).toContain('(empty)');
  });

  it('appends the style directive when present', () => {
    const out = buildUnifiedChatInstructions({ styleDirectiveStr: 'STYLE-X' });
    expect(out).toContain('STYLE-X');
  });

  it('omits an empty style directive without a spurious blank section', () => {
    const out = buildUnifiedChatInstructions({ styleDirectiveStr: '   ' });
    expect(out).toBe(`${UNIFIED_CHAT_SURFACE_PROMPT}\n\n=== Current document ===\n(empty)\n=== End document ===`);
  });
});

describe('collaborator surface prompt content', () => {
  it('frames an apply-oriented collaborator and forbids inventing facts', () => {
    expect(UNIFIED_CHAT_SURFACE_PROMPT).toContain('writing collaborator');
    expect(UNIFIED_CHAT_SURFACE_PROMPT).toMatch(/Never invent facts/i);
    expect(UNIFIED_CHAT_SURFACE_PROMPT).toMatch(/Korean or English/);
  });
});
