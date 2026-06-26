/**
 * grok-cli-provider.ts — Grok completion via the local `grok` CLI (Grok Build,
 * cmux shim) in headless single-turn mode with tools/web disabled. The prompt is
 * delivered through a 0o600 temp file via `--prompt-file` (NOT argv: `grok
 * --single` would expose the prompt in the process list), so argv carries only
 * static flags + the random temp path. Output is the `--output-format
 * streaming-json` NDJSON stream. CLI-only: no API key and no paid fallback — a
 * missing/unauthenticated CLI surfaces an install/login guidance error. (G005)
 */

import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';

import type { AiChatEvent, AiChatRequest, AiProvider, ModelRef, ProviderAuthStatus } from './types';
import { runCliCompletion, probeCliAvailability, buildMinimalEnv, type CliSpawn, type CliLineMapper } from './cli-runner';
import { buildCliPrompt } from './cli-prompt';

/**
 * Map a `grok --output-format streaming-json` NDJSON record (empirically captured,
 * G005): answer text is `{type:'text',data}`, the run ends with
 * `{type:'end',stopReason}`, errors are `{type:'error',...}`, and `{type:'thought'}`
 * reasoning tokens are ignored for v0.7 completion mode.
 */
export const mapGrokStreamingJson: CliLineMapper = (rec) => {
  const r = rec as { type?: string; data?: string; message?: string };
  if (r.type === 'text') return { delta: r.data ?? '' };
  if (r.type === 'end') return { done: true };
  if (r.type === 'error') return { error: r.message ?? r.data ?? 'Grok CLI error' };
  return null;
};

const GROK_DISALLOWED_TOOLS = 'bash,read,write,edit';

export type PromptFileWriter = (content: string) => Promise<{ path: string; cleanup: () => Promise<void> }>;

const defaultWritePromptFile: PromptFileWriter = async (content) => {
  const p = path.join(os.tmpdir(), `notepad-grok-${randomUUID()}.txt`);
  await fs.writeFile(p, content, { mode: 0o600 });
  return {
    path: p,
    cleanup: async () => {
      try {
        await fs.unlink(p);
      } catch {
        /* best effort */
      }
    },
  };
};

const GROK_MODEL: ModelRef = {
  provider: 'grok',
  id: 'grok',
  label: 'Grok (CLI)',
  humanizeEngineId: 'openai',
  requiresAuth: true,
};

export class GrokCliProvider implements AiProvider {
  readonly id = 'grok' as const;
  readonly authKind = 'cli' as const;

  constructor(private deps: { spawn: CliSpawn; command?: string; writePromptFile?: PromptFileWriter }) {}

  private cmd(): string {
    return this.deps.command ?? 'grok';
  }

  async getAuthStatus(): Promise<ProviderAuthStatus> {
    const r = await probeCliAvailability({
      spawn: this.deps.spawn,
      command: this.cmd(),
      probeArgs: ['--version'],
      env: buildMinimalEnv(),
      cwd: os.tmpdir(),
    });
    return {
      provider: 'grok',
      authKind: 'cli',
      connected: r.available,
      label: 'Grok (CLI)',
      error: r.available ? undefined : 'Grok CLI not found. Install grok and run `grok login`.',
    };
  }

  async listModels(): Promise<ModelRef[]> {
    return [GROK_MODEL];
  }

  async streamChat(req: AiChatRequest, onEvent: (e: AiChatEvent) => void): Promise<void> {
    const writer = this.deps.writePromptFile ?? defaultWritePromptFile;
    const file = await writer(buildCliPrompt(req));
    try {
      await runCliCompletion({
        spawn: this.deps.spawn,
        command: this.cmd(),
        // Static argv only: the prompt lives in the temp file, not the command line.
        args: [
          '--prompt-file',
          file.path,
          '--output-format',
          'streaming-json',
          '--disallowed-tools',
          GROK_DISALLOWED_TOOLS,
          '--disable-web-search',
        ],
        prompt: '', // grok reads the prompt from --prompt-file; stdin stays empty.
        mapLine: mapGrokStreamingJson,
        env: buildMinimalEnv(),
        cwd: os.tmpdir(),
        signal: req.signal,
        onEvent,
      });
    } finally {
      await file.cleanup();
    }
  }
}
