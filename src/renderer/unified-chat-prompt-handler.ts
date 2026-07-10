/**
 * unified-chat-prompt-handler.ts — instructions for the unified writing
 * collaborator chat.
 */

/** Collaborator surface prompt for the unified chat. */
export const UNIFIED_CHAT_SURFACE_PROMPT =
  `You are a writing collaborator inside a Mac Markdown editor.\n` +
  `You help draft, revise, and advise on the user's document. When the user asks\n` +
  `for content, reply ONLY with the final Markdown (no code fences, no preamble)\n` +
  `so it can be inserted directly. When the user asks a question or for an\n` +
  `opinion, answer conversationally instead.\n` +
  `\n` +
  `Rules:\n` +
  `- Preserve existing structure (headings, lists, tables) when revising.\n` +
  `- Never invent facts, numbers, names, or quotes.\n` +
  `- Match the user's language (Korean or English).`;

export type UnifiedChatPromptRequest = {
  /** Style directive (difficulty + always-on humanize). */
  styleDirectiveStr?: string;
  /** Current document context, pre-truncated by the caller. */
  documentText?: string;
};

export function buildUnifiedChatInstructions(req: UnifiedChatPromptRequest): string {
  const styleStr = (req.styleDirectiveStr ?? '').trim();
  const parts: string[] = [UNIFIED_CHAT_SURFACE_PROMPT];
  if (styleStr.length > 0) parts.push(styleStr);
  const rawDoc = req.documentText ?? '';
  const docContent = rawDoc.trim().length > 0 ? rawDoc : '(empty)';
  parts.push(`=== Current document ===\n${docContent}\n=== End document ===`);
  return parts.join('\n\n');
}
