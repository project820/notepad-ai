/**
 * Pure request-shaping helpers for provider chat APIs. Unit tested.
 */

import type { AiImageAttachment, ChatTurn, SurfaceMode } from './types';

type OpenAiTextPart = { type: 'text'; text: string };
type OpenAiImagePart = { type: 'image_url'; image_url: { url: string } };
type AnthropicTextPart = { type: 'text'; text: string };
export type AnthropicImagePart = {
  type: 'image';
  source: { type: 'base64'; media_type: string; data: string };
};
export type WireContent =
  | string
  | Array<OpenAiTextPart | OpenAiImagePart | AnthropicTextPart | AnthropicImagePart>;

export type WireMessage = { role: 'system' | 'user' | 'assistant'; content: WireContent };

/** OpenAI-compatible multimodal user content: text part + one image_url part per image. */
export function openAiUserContent(userText: string, images?: AiImageAttachment[]): WireContent {
  if (!images || images.length === 0) return userText;
  const parts: Array<OpenAiTextPart | OpenAiImagePart> = [];
  if (userText) parts.push({ type: 'text', text: userText });
  for (const img of images) {
    parts.push({ type: 'image_url', image_url: { url: `data:${img.mime};base64,${img.base64}` } });
  }
  return parts;
}

/** Anthropic image content blocks (base64 source). */
export function anthropicImageBlocks(images: AiImageAttachment[]): AnthropicImagePart[] {
  return images.map((img) => ({
    type: 'image',
    source: { type: 'base64', media_type: img.mime, data: img.base64 },
  }));
}

/**
 * Write-mode re-anchor. 작성/상담 share one thread, so a later Write turn can
 * inherit conversational Advise history. This final system reminder re-pins the
 * model to strict raw-document output so guardVerdict / apply stays intact.
 */
export const WRITE_REANCHOR_SYSTEM =
  'Output ONLY the requested document text as Markdown. You are producing content to be applied directly to the editor: no conversational filler, no preamble, no closing remarks, no questions, no meta commentary. Preserve every fact, number, code span, and quotation exactly.';

/** True only for Write turns (the one surface that demands raw document output). */
export function shouldWriteReanchor(surfaceMode?: SurfaceMode): boolean {
  return surfaceMode === 'write';
}

/**
 * Append the Write re-anchor to a top-level system/instructions string
 * (Anthropic `system` field, ChatGPT `instructions`). No-op for non-Write turns.
 */
export function appendWriteReanchor(base: string, surfaceMode?: SurfaceMode): string {
  if (!shouldWriteReanchor(surfaceMode)) return base;
  return base.trim() ? `${base}\n\n${WRITE_REANCHOR_SYSTEM}` : WRITE_REANCHOR_SYSTEM;
}

/**
 * Build Anthropic Messages API messages from history + the new user turn.
 * - Merges consecutive same-role turns (Anthropic requires alternation).
 * - Drops leading assistant turns (Anthropic requires the first message to be `user`).
 * The system prompt is passed separately via the top-level `system` field.
 */
export function toAnthropicMessages(
  history: ChatTurn[],
  userText: string,
  images?: AiImageAttachment[],
): WireMessage[] {
  const turns: ChatTurn[] = [...history, { role: 'user', text: userText }];
  // Merge consecutive same-role turns as plain text first (alternation rule).
  const merged: { role: 'system' | 'user' | 'assistant'; text: string }[] = [];
  for (const turn of turns) {
    if (!turn.text) continue;
    const last = merged[merged.length - 1];
    if (last && last.role === turn.role) last.text += `\n\n${turn.text}`;
    else merged.push({ role: turn.role, text: turn.text });
  }
  while (merged.length > 0 && merged[0].role === 'assistant') merged.shift();
  const out: WireMessage[] = merged.map((m) => ({ role: m.role, content: m.text }));
  // Attach image blocks to the final user turn. Handles the image-only case
  // (empty text drops the turn during merge) by appending a fresh user message
  // so Claude always receives a trailing user turn with the images.
  if (images && images.length > 0) {
    const blocks = anthropicImageBlocks(images);
    const lastMsg = out[out.length - 1];
    if (lastMsg && lastMsg.role === 'user' && typeof lastMsg.content === 'string') {
      lastMsg.content = [{ type: 'text', text: lastMsg.content }, ...blocks];
    } else {
      out.push({
        role: 'user',
        content: userText.trim() ? [{ type: 'text', text: userText }, ...blocks] : blocks,
      });
    }
  }
  return out;
}

/**
 * Build OpenAI-compatible (OpenRouter) messages: system instructions first,
 * then history, then the new user turn.
 */
export function toOpenAiMessages(
  instructions: string,
  history: ChatTurn[],
  userText: string,
  surfaceMode?: SurfaceMode,
  images?: AiImageAttachment[],
): WireMessage[] {
  const messages: WireMessage[] = [];
  if (instructions.trim()) messages.push({ role: 'system', content: instructions });
  for (const turn of history) {
    if (turn.text) messages.push({ role: turn.role, content: turn.text });
  }
  // Write-only re-anchor sits right before the final user turn (after Advise history).
  if (shouldWriteReanchor(surfaceMode)) messages.push({ role: 'system', content: WRITE_REANCHOR_SYSTEM });
  messages.push({ role: 'user', content: openAiUserContent(userText, images) });
  return messages;
}
