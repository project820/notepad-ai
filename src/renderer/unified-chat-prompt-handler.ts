/**
 * unified-chat-prompt-handler.ts — prompt assembly for the unified collaborator
 * chat (G003) that replaces Side Chat (⌘J) + Bottom Chat (⌘;).
 *
 * Mirrors the established adapter pattern (bottom-chat-adapter.ts): a pure,
 * dependency-injected function routing between the legacy concat path and the
 * 7-layer assembler. The unified chat is a WRITING COLLABORATOR: it can draft,
 * revise, or advise, and its output is apply-oriented (insert/replace into the
 * document). It reuses the `BottomChat` surface slot (the unified chat is the
 * apply-capable successor of the bottom chat), so no AISurface change is needed.
 */

import { assemblePrompt, type AssemblyRequest } from '../main/prompts/assemble';

/** Collaborator surface prompt (layer 3) for the unified chat. */
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
  toggleEnabled: boolean;
  systemlawContent?: string;
  ownerContent?: string;
  /** Style directive (difficulty + always-on humanize) for layer 4. */
  styleDirectiveStr?: string;
  /** Current document context (layer 5), pre-truncated by the caller. */
  documentText?: string;
};

export type AssemblerFn = (req: AssemblyRequest) => string;

export function buildUnifiedChatInstructions(
  req: UnifiedChatPromptRequest,
  assemble: AssemblerFn = assemblePrompt,
): string {
  const styleStr = (req.styleDirectiveStr ?? '').trim();

  if (req.toggleEnabled) {
    const assemblyReq: AssemblyRequest = {
      surface: 'BottomChat',
      systemlawContent: req.systemlawContent ?? '',
      ownerContent: req.ownerContent ?? '',
      surfacePrompt: UNIFIED_CHAT_SURFACE_PROMPT,
      qualityDirective: styleStr,
      documentText: req.documentText ?? '',
    };
    return assemble(assemblyReq);
  }

  // Legacy path: surface prompt + style + document section.
  const parts: string[] = [UNIFIED_CHAT_SURFACE_PROMPT];
  if (styleStr.length > 0) parts.push(styleStr);
  const rawDoc = req.documentText ?? '';
  const docContent = rawDoc.trim().length > 0 ? rawDoc : '(empty)';
  parts.push(`=== Current document ===\n${docContent}\n=== End document ===`);
  return parts.join('\n\n');
}
