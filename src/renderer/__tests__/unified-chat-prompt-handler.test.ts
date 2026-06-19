import { describe, expect, it, vi } from 'vitest';

import {
  buildUnifiedChatInstructions,
  UNIFIED_CHAT_SURFACE_PROMPT,
  type AssemblerFn,
} from '../unified-chat-prompt-handler';

describe('buildUnifiedChatInstructions — legacy path (toggle off)', () => {
  it('includes the collaborator surface prompt and a document section', () => {
    const out = buildUnifiedChatInstructions({ toggleEnabled: false, documentText: 'hello' });
    expect(out).toContain(UNIFIED_CHAT_SURFACE_PROMPT);
    expect(out).toContain('=== Current document ===');
    expect(out).toContain('hello');
  });
  it('uses (empty) when no document text', () => {
    expect(buildUnifiedChatInstructions({ toggleEnabled: false })).toContain('(empty)');
  });
  it('appends the style directive when present', () => {
    const out = buildUnifiedChatInstructions({ toggleEnabled: false, styleDirectiveStr: 'STYLE-X' });
    expect(out).toContain('STYLE-X');
  });
  it('omits an empty style directive (no spurious blank section)', () => {
    const out = buildUnifiedChatInstructions({ toggleEnabled: false, styleDirectiveStr: '   ' });
    expect(out).toBe(`${UNIFIED_CHAT_SURFACE_PROMPT}\n\n=== Current document ===\n(empty)\n=== End document ===`);
  });
  it('does not call the assembler when toggle is off', () => {
    const asm = vi.fn(() => 'X');
    buildUnifiedChatInstructions({ toggleEnabled: false }, asm);
    expect(asm).not.toHaveBeenCalled();
  });
});

describe('buildUnifiedChatInstructions — assembler path (toggle on)', () => {
  it('routes through the assembler with the BottomChat surface and collaborator prompt', () => {
    let captured: Parameters<AssemblerFn>[0] | undefined;
    const asm: AssemblerFn = vi.fn((r) => {
      captured = r;
      return 'ASSEMBLED';
    });
    const out = buildUnifiedChatInstructions(
      { toggleEnabled: true, systemlawContent: 'law', ownerContent: 'owner', styleDirectiveStr: 'style', documentText: 'doc' },
      asm,
    );
    expect(out).toBe('ASSEMBLED');
    expect(asm).toHaveBeenCalledTimes(1);
    const req = captured!;
    expect(req.surface).toBe('BottomChat');
    expect(req.surfacePrompt).toBe(UNIFIED_CHAT_SURFACE_PROMPT);
    expect(req.systemlawContent).toBe('law');
    expect(req.ownerContent).toBe('owner');
    expect(req.qualityDirective).toBe('style');
    expect(req.documentText).toBe('doc');
  });
  it('never throws on empty input and returns a string', () => {
    expect(typeof buildUnifiedChatInstructions({ toggleEnabled: true }, () => '')).toBe('string');
  });
});

describe('collaborator surface prompt content', () => {
  it('frames an apply-oriented collaborator and forbids inventing facts', () => {
    expect(UNIFIED_CHAT_SURFACE_PROMPT).toContain('writing collaborator');
    expect(UNIFIED_CHAT_SURFACE_PROMPT).toMatch(/Never invent facts/i);
    expect(UNIFIED_CHAT_SURFACE_PROMPT).toMatch(/Korean or English/);
  });
});
