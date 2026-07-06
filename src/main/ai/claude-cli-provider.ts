/**
 * claude-cli-provider.ts — Claude completion via the local `claude` CLI (Claude
 * Code, cmux shim) in print/non-interactive mode with all tools disabled. Prompt
 * is delivered via stdin; argv carries only static routing flags + the model id.
 * Output is the `--output-format stream-json` NDJSON event stream, mapped to
 * AiChatEvents. CLI-first cost-saving path; the Anthropic API fallback is added
 * by composing this with the API provider via FallbackProvider (G004/G006).
 */

import os from 'node:os';

import type { AiChatEvent, AiChatRequest } from './types';
import { runCliCompletion, probeCliAvailability, buildMinimalEnv, type CliSpawn, type CliLineMapper } from './cli-runner';
import { buildCliPrompt } from './cli-prompt';
import type { StreamSource } from './fallback-provider';

/**
 * Map a `claude -p --output-format stream-json` NDJSON record to a stream effect.
 * Schema (empirically captured, G004): assistant text lives in
 * `{type:'assistant',message:{content:[{type:'text',text}]}}`; the run ends with
 * `{type:'result',subtype:'success',result}` (or `is_error`/`subtype:'error'`).
 * system/hook/init/rate_limit_event records are ignored.
 */
export const mapClaudeStreamJson: CliLineMapper = (rec) => {
  const r = rec as {
    type?: string;
    subtype?: string;
    is_error?: boolean;
    result?: string;
    message?: { content?: Array<{ type?: string; text?: string }> };
  };
  if (r.type === 'assistant' && Array.isArray(r.message?.content)) {
    const text = r.message!.content!
      .filter((c) => c?.type === 'text')
      .map((c) => c.text ?? '')
      .join('');
    return text ? { delta: text } : null;
  }
  if (r.type === 'result') {
    if (r.is_error || r.subtype === 'error') {
      return { error: typeof r.result === 'string' && r.result ? r.result : 'Claude CLI error' };
    }
    return { done: true };
  }
  return null;
};

// Comprehensive denylist: every built-in tool is disabled so the CLI behaves as a
// plain completion endpoint with no file/system access (v0.7 completion mode).
const CLAUDE_DISALLOWED_TOOLS =
  'Bash Read Write Edit MultiEdit NotebookEdit WebSearch WebFetch Glob Grep Task TodoWrite';

export class ClaudeCliProvider implements StreamSource {
  constructor(private deps: { spawn: CliSpawn; command?: string }) {}

  private cmd(): string {
    return this.deps.command ?? 'claude';
  }

  /** Probe install/login state with static args + minimal env (no prompt content). */
  async isAvailable(): Promise<boolean> {
    const r = await probeCliAvailability({
      spawn: this.deps.spawn,
      command: this.cmd(),
      probeArgs: ['--version'],
      env: await buildMinimalEnv(),
      cwd: os.tmpdir(),
    });
    return r.available;
  }

  async streamChat(req: AiChatRequest, onEvent: (e: AiChatEvent) => void): Promise<void> {
    const args = [
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--input-format',
      'text',
      '--disallowedTools',
      CLAUDE_DISALLOWED_TOOLS,
    ];
    if (req.model?.id) args.push('--model', req.model.id);
    await runCliCompletion({
      spawn: this.deps.spawn,
      command: this.cmd(),
      args,
      prompt: buildCliPrompt(req),
      mapLine: mapClaudeStreamJson,
      env: await buildMinimalEnv(),
      cwd: os.tmpdir(),
      signal: req.signal,
      onEvent,
    });
  }
}
