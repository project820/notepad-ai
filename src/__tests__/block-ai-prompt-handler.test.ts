import { describe, expect, it } from 'vitest';

import {
  BLOCK_AI_SURFACE_PROMPT,
  buildBlockAiInstructions,
} from '../renderer/block-ai-prompt-handler';

describe('buildBlockAiInstructions', () => {
  it('returns the surface prompt when no style directive is provided', () => {
    expect(buildBlockAiInstructions({})).toBe(BLOCK_AI_SURFACE_PROMPT);
  });

  it('appends a non-empty style directive', () => {
    expect(buildBlockAiInstructions({ qualityDirectiveStr: 'STYLE-X' })).toBe(
      `${BLOCK_AI_SURFACE_PROMPT}\n\nSTYLE-X`,
    );
  });

  it('omits whitespace-only style directives', () => {
    expect(buildBlockAiInstructions({ qualityDirectiveStr: '  ' })).toBe(BLOCK_AI_SURFACE_PROMPT);
  });
});
