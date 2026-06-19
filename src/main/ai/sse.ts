/**
 * Pure SSE parsing helpers shared by the Claude and OpenRouter providers.
 *
 * Kept free of any I/O so they can be unit tested directly. Each provider's
 * streaming loop feeds raw decoded chunks into `splitSseEvents` and then maps
 * the data payloads through the provider-specific delta extractor.
 */

/**
 * Split an SSE buffer into complete events (separated by a blank line) and the
 * unconsumed remainder. Handles both "\n\n" and "\r\n\r\n" separators.
 */
export function splitSseEvents(buffer: string): { events: string[]; rest: string } {
  const normalized = buffer.replace(/\r\n/g, '\n');
  const events: string[] = [];
  let rest = normalized;
  let idx: number;
  while ((idx = rest.indexOf('\n\n')) !== -1) {
    const block = rest.slice(0, idx).trim();
    rest = rest.slice(idx + 2);
    if (block) events.push(block);
  }
  return { events, rest };
}

/** Join the `data:` lines of one SSE event block into a single payload string. */
export function sseDataPayload(eventBlock: string): string {
  const dataLines: string[] = [];
  for (const line of eventBlock.split('\n')) {
    if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
  }
  return dataLines.join('\n');
}

/**
 * Extract the text delta from one Anthropic Messages API SSE data payload.
 * Returns '' for any non-text or unparseable event (tolerant by design).
 *
 * Relevant shape: { type: "content_block_delta", delta: { type: "text_delta", text } }
 */
export function extractClaudeTextDelta(dataPayload: string): string {
  if (!dataPayload || dataPayload === '[DONE]') return '';
  try {
    const evt = JSON.parse(dataPayload);
    if (evt?.type === 'content_block_delta' && evt?.delta?.type === 'text_delta') {
      return typeof evt.delta.text === 'string' ? evt.delta.text : '';
    }
    return '';
  } catch {
    return '';
  }
}

/** True when a Claude SSE event signals a terminal error event. */
export function claudeErrorMessage(dataPayload: string): string | null {
  try {
    const evt = JSON.parse(dataPayload);
    if (evt?.type === 'error') {
      const msg = evt?.error?.message ?? evt?.error?.type ?? 'stream error';
      return typeof msg === 'string' ? msg : 'stream error';
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Extract the text delta from one OpenAI-compatible (OpenRouter) SSE data
 * payload. Returns '' for keep-alives, `[DONE]`, or non-text events.
 *
 * Relevant shape: { choices: [ { delta: { content } } ] }
 */
export function extractOpenAiTextDelta(dataPayload: string): string {
  if (!dataPayload || dataPayload === '[DONE]') return '';
  try {
    const evt = JSON.parse(dataPayload);
    const choice = Array.isArray(evt?.choices) ? evt.choices[0] : undefined;
    const content = choice?.delta?.content;
    return typeof content === 'string' ? content : '';
  } catch {
    return '';
  }
}

/** True when an OpenAI-compatible data payload is the terminal sentinel. */
export function isOpenAiDone(dataPayload: string): boolean {
  return dataPayload.trim() === '[DONE]';
}
