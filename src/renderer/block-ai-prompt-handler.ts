/**
 * block-ai-prompt-handler.ts — instructions for the Block AI rewrite surface.
 */

/** The verbatim Block AI system prompt. */
export const BLOCK_AI_SURFACE_PROMPT =
  `You are a focused text-rewriting assistant inside a Markdown editor.
The user has selected a fragment of text and given an instruction.
Produce EXACTLY 3 alternative rewrites of the fragment. Rules:
- Output ONLY the 3 alternatives.
- Separate each alternative with a line containing exactly three dashes: ---
- Preserve the markdown semantic of the selection (heading stays heading, list stays list).
- Keep length in the same ballpark as the original unless the instruction asks otherwise.
- Match the user's language (Korean or English).
- No numbering, no commentary, no preamble.`;

export type BlockAiPromptRequest = {
  /** The quality-dial directive string. */
  qualityDirectiveStr?: string;
};

/** Build the Block AI instructions string. */
export function buildBlockAiInstructions(req: BlockAiPromptRequest): string {
  const qualityStr = req.qualityDirectiveStr ?? '';
  const parts = [BLOCK_AI_SURFACE_PROMPT, qualityStr].filter((s) => s.trim().length > 0);
  return parts.join('\n\n');
}
