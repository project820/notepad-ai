/**
 * Pure request-shaping helpers for provider chat APIs. Unit tested.
 */

import type { ChatTurn } from './types';

export type WireMessage = { role: 'system' | 'user' | 'assistant'; content: string };

/**
 * Build Anthropic Messages API messages from history + the new user turn.
 * - Merges consecutive same-role turns (Anthropic requires alternation).
 * - Drops leading assistant turns (Anthropic requires the first message to be `user`).
 * The system prompt is passed separately via the top-level `system` field.
 */
export function toAnthropicMessages(history: ChatTurn[], userText: string): WireMessage[] {
  const turns: ChatTurn[] = [...history, { role: 'user', text: userText }];
  const merged: WireMessage[] = [];
  for (const turn of turns) {
    if (!turn.text) continue;
    const last = merged[merged.length - 1];
    if (last && last.role === turn.role) {
      last.content += `\n\n${turn.text}`;
    } else {
      merged.push({ role: turn.role, content: turn.text });
    }
  }
  // Drop any leading assistant messages so the array starts with `user`.
  while (merged.length > 0 && merged[0].role === 'assistant') merged.shift();
  return merged;
}

/**
 * Build OpenAI-compatible (OpenRouter) messages: system instructions first,
 * then history, then the new user turn.
 */
export function toOpenAiMessages(
  instructions: string,
  history: ChatTurn[],
  userText: string,
): WireMessage[] {
  const messages: WireMessage[] = [];
  if (instructions.trim()) messages.push({ role: 'system', content: instructions });
  for (const turn of history) {
    if (turn.text) messages.push({ role: turn.role, content: turn.text });
  }
  messages.push({ role: 'user', content: userText });
  return messages;
}
