/**
 * cli-prompt.ts — assemble a single stdin prompt for a local CLI provider from an
 * AiChatRequest. Instructions (system + Write re-anchor), prior turns, and the
 * user text are folded into one text block delivered via stdin (NEVER argv). No
 * file paths, workspace roots, or grants are ever included. (G004)
 */

import type { AiChatRequest } from './types';
import { appendWriteReanchor } from './messages';

export function buildCliPrompt(req: AiChatRequest): string {
  const parts: string[] = [];
  const sys = appendWriteReanchor(req.instructions ?? '', req.surfaceMode);
  if (sys.trim()) parts.push(sys.trim());
  for (const turn of req.history ?? []) {
    const role = turn.role === 'assistant' ? 'Assistant' : 'User';
    parts.push(`${role}: ${turn.text}`);
  }
  parts.push(`User: ${req.userText ?? ''}`);
  return parts.join('\n\n');
}
