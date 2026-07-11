import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { GrokCliProvider, mapGrokStreamingJson, type PromptFileWriter } from '../main/ai/grok-cli-provider';
import { __setShellExecForTests, __setCliProbeForTests, __resetCliSpawnPathForTests, type CliProcess } from '../main/ai/cli-runner';
import type { AiChatEvent, AiChatRequest } from '../main/ai/types';

class FakeChild implements CliProcess {
  stdinChunks: string[] = [];
  killed = false;
  private out: Array<(c: string) => void> = [];
  private errCb: Array<(c: string) => void> = [];
  private closeCbs: Array<(c: number | null) => void> = [];
  private errorCbs: Array<(e: Error) => void> = [];
  stdin = { write: (c: string) => this.stdinChunks.push(c), end: () => {} };
  stdout = { on: (_e: 'data', cb: (c: string) => void) => { this.out.push(cb); } };
  stderr = { on: (_e: 'data', cb: (c: string) => void) => { this.errCb.push(cb); } };
  on(ev: 'error' | 'close', cb: (...a: never[]) => void) {
    if (ev === 'close') this.closeCbs.push(cb as (c: number | null) => void);
    if (ev === 'error') this.errorCbs.push(cb as (e: Error) => void);
  }
  kill() { this.killed = true; }
  emitOut(s: string) { this.out.forEach((cb) => cb(s)); }
  doClose(code: number | null) { this.closeCbs.forEach((cb) => cb(code)); }
}

const req: AiChatRequest = {
  instructions: 'sys',
  history: [],
  userText: 'SENTINEL-USER-TEXT',
  model: { provider: 'grok', id: 'grok' },
};

// Provider methods now `await buildMinimalEnv()` (async PATH resolver) before spawning.
// Stub the resolver so these tests never exec the real login shell and resolve fast.
beforeEach(() => {
  __setShellExecForTests(async () => 'GJC_PATH=/usr/bin\n');
  __setCliProbeForTests(() => true);
});
afterEach(() => __resetCliSpawnPathForTests());

describe('mapGrokStreamingJson (real streaming-json schema)', () => {
  it('maps text->delta, end->done, error->error, thought->null', () => {
    expect(mapGrokStreamingJson({ type: 'text', data: 'hi' })).toEqual({ delta: 'hi' });
    expect(mapGrokStreamingJson({ type: 'end', stopReason: 'EndTurn' })).toEqual({ done: true });
    expect(mapGrokStreamingJson({ type: 'error', message: 'boom' })).toEqual({ error: 'boom' });
    expect(mapGrokStreamingJson({ type: 'thought', data: 'reasoning' })).toBeNull();
  });
});

describe('GrokCliProvider', () => {
  function harness() {
    let child: FakeChild | undefined;
    let args: string[] = [];
    let promptFileContent = '';
    const cleanup = vi.fn(async () => {});
    const writePromptFile: PromptFileWriter = async (content) => {
      promptFileContent = content;
      return { path: '/tmp/fake-grok-prompt.txt', cleanup };
    };
    const spawn = (_c: string, a: string[]) => { args = a; child = new FakeChild(); return child; };
    const provider = new GrokCliProvider({ spawn, writePromptFile });
    const events: AiChatEvent[] = [];
    const promise = provider.streamChat(req, (e) => events.push(e));
    return { promise, getChild: () => child!, getArgs: () => args, events, cleanup, getPromptContent: () => promptFileContent };
  }

  it('streams text deltas then done; prompt via temp file (not argv); cleans up', async () => {
    const h = harness();
    await new Promise((r) => setTimeout(r, 0)); // let writePromptFile resolve → spawn
    const child = h.getChild();
    child.emitOut('{"type":"thought","data":"thinking"}\n');
    child.emitOut('{"type":"text","data":"hi"}\n');
    child.emitOut('{"type":"text","data":" there"}\n');
    child.emitOut('{"type":"end","stopReason":"EndTurn"}\n');
    await h.promise;

    expect(h.events.filter((e) => e.kind === 'delta').map((e) => (e as { text: string }).text)).toEqual(['hi', ' there']);
    expect(h.events.at(-1)?.kind).toBe('done');
    // Prompt path passed via --prompt-file; user text NEVER in argv.
    expect(h.getArgs()).toContain('--prompt-file');
    expect(h.getArgs()).toContain('/tmp/fake-grok-prompt.txt');
    expect(h.getArgs()).toContain('--disable-web-search');
    expect(h.getArgs().join(' ')).not.toContain('SENTINEL-USER-TEXT');
    // Prompt content went into the temp file.
    expect(h.getPromptContent()).toContain('SENTINEL-USER-TEXT');
    // Temp file cleaned up after the run.
    expect(h.cleanup).toHaveBeenCalledTimes(1);
  });

  it('cleans up the temp prompt file even when the run errors', async () => {
    const h = harness();
    await new Promise((r) => setTimeout(r, 0)); // let writePromptFile resolve → spawn
    const child = h.getChild();
    child.emitOut('{"type":"error","message":"login required"}\n');
    await h.promise;
    expect(h.events.some((e) => e.kind === 'error')).toBe(true);
    expect(h.cleanup).toHaveBeenCalledTimes(1);
  });
});

describe('GrokCliProvider auth + models', () => {
  it('reports installed-but-auth-unverified when the version probe exits 0', async () => {
    const spawn = () => {
      const c = new FakeChild();
      queueMicrotask(() => c.doClose(0));
      return c;
    };
    const provider = new GrokCliProvider({ spawn });
    const status = await provider.getAuthStatus();
    expect(status).toMatchObject({
      provider: 'grok',
      authKind: 'cli',
      connected: false,
      installed: true,
      errorCode: 'grok_cli_auth_unknown',
    });
  });
  it('reports a stable setup status code when the CLI is absent', async () => {
    const spawn = () => {
      const c = new FakeChild();
      queueMicrotask(() => c.doClose(127));
      return c;
    };
    const provider = new GrokCliProvider({ spawn });
    const status = await provider.getAuthStatus();
    expect(status).toMatchObject({ installed: false, errorCode: 'grok_cli_setup_required' });
    expect(status.error).toBeUndefined();
  });
  it('lists a single default Grok CLI model', async () => {
    const provider = new GrokCliProvider({ spawn: () => new FakeChild() });
    const models = await provider.listModels();
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({ provider: 'grok', id: 'grok', requiresAuth: true });
  });
});
