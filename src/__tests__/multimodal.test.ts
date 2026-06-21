import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import { supportsVision } from '../main/ai/vision-capabilities';
import { resolveOcrAssetPaths, OCR_LANGS } from '../main/ai/ocr';
import {
  validateImageAttachments,
  MAX_IMAGE_ATTACHMENTS,
  MAX_IMAGE_BYTES,
  type AiImageAttachment,
  type AiChatRequest,
  type AiChatEvent,
  type AiProvider,
} from '../main/ai/types';
import {
  openAiUserContent,
  anthropicImageBlocks,
  toOpenAiMessages,
  toAnthropicMessages,
} from '../main/ai/messages';
import { ProviderRegistry, type ProviderMap } from '../main/ai/provider-registry';

const img = (over: Partial<AiImageAttachment> = {}): AiImageAttachment => ({
  mime: 'image/png',
  base64: 'AAAA',
  bytes: 100,
  ...over,
});

describe('supportsVision (G007/D2 strict allowlist)', () => {
  it('allows verified cloud vision models only', () => {
    expect(supportsVision('claude', 'claude-opus-4-8')).toBe(true);
    expect(supportsVision('openrouter', 'openai/gpt-4o')).toBe(true);
    expect(supportsVision('openrouter', 'google/gemini-2.0-flash')).toBe(true);
  });
  it('rejects ChatGPT (codex backend), local, and unknown custom models', () => {
    expect(supportsVision('chatgpt', 'gpt-4o')).toBe(false); // codex backend → OCR
    expect(supportsVision('ollama', 'llava')).toBe(false);
    expect(supportsVision('lmstudio', 'qwen2-vl')).toBe(false);
    expect(supportsVision('openrouter', 'some/unknown-text-model')).toBe(false);
    expect(supportsVision(undefined, undefined)).toBe(false);
  });
});

describe('resolveOcrAssetPaths (G007/A2 local-only, no CDN)', () => {
  it('resolves packaged paths under resourcesPath/tesseract', () => {
    const p = resolveOcrAssetPaths({ appPath: '/app', resourcesPath: '/res', packaged: true });
    expect(p.workerPath).toContain('/res/tesseract');
    expect(p.langPath).toContain('/res/tesseract');
    expect(OCR_LANGS).toBe('kor+eng');
  });
  it('resolves dev paths under node_modules + resources/tessdata', () => {
    const p = resolveOcrAssetPaths({ appPath: '/proj', resourcesPath: '/res', packaged: false });
    expect(p.workerPath).toContain('/proj/node_modules/tesseract.js');
    expect(p.langPath).toContain('/proj/resources/tessdata');
  });
  it('hard-fails when a resolved path would be a URL (no CDN fallback)', () => {
    expect(() =>
      resolveOcrAssetPaths({ appPath: 'https://unpkg.com/x', resourcesPath: '/res', packaged: false }),
    ).toThrow(/bundled local path/);
  });
});

describe('validateImageAttachments (G007 IPC boundary)', () => {
  it('accepts a valid attachment and normalizes name length', () => {
    const res = validateImageAttachments([img({ name: 'x'.repeat(500) })]);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.images[0].name!.length).toBe(200);
  });
  it('treats null/undefined as no images', () => {
    expect(validateImageAttachments(undefined)).toEqual({ ok: true, images: [] });
    expect(validateImageAttachments(null)).toEqual({ ok: true, images: [] });
  });
  it('rejects bad type, oversized, too many, and non-array', () => {
    expect(validateImageAttachments('x').ok).toBe(false);
    expect(validateImageAttachments([img({ mime: 'image/gif' as never })]).ok).toBe(false);
    expect(validateImageAttachments([img({ bytes: MAX_IMAGE_BYTES + 1 })]).ok).toBe(false);
    expect(validateImageAttachments(Array.from({ length: MAX_IMAGE_ATTACHMENTS + 1 }, () => img())).ok).toBe(false);
    expect(validateImageAttachments([img({ base64: '' })]).ok).toBe(false);
  });
});

describe('multimodal message builders', () => {
  it('openAiUserContent returns a string with no images and a parts array with images', () => {
    expect(openAiUserContent('hi')).toBe('hi');
    const content = openAiUserContent('describe', [img()]);
    expect(Array.isArray(content)).toBe(true);
    expect(content[0]).toEqual({ type: 'text', text: 'describe' });
    expect((content as any[])[1]).toEqual({ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } });
  });
  it('anthropicImageBlocks builds base64 source blocks', () => {
    expect(anthropicImageBlocks([img()])[0]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'AAAA' },
    });
  });
  it('toOpenAiMessages attaches images to the final user message only', () => {
    const msgs = toOpenAiMessages('i', [], 'q', undefined, [img()]);
    expect(Array.isArray(msgs[msgs.length - 1].content)).toBe(true);
  });
  it('toOpenAiMessages keeps content a plain string when no images (regression)', () => {
    const msgs = toOpenAiMessages('i', [], 'q');
    expect(msgs[msgs.length - 1].content).toBe('q');
  });
  it('toAnthropicMessages attaches image blocks to the final user message', () => {
    const msgs = toAnthropicMessages([], 'q', [img()]);
    const last = msgs[msgs.length - 1];
    expect(Array.isArray(last.content)).toBe(true);
    expect((last.content as any[]).some((p) => p.type === 'image')).toBe(true);
  });
});

function capturingProvider(id: AiProvider['id']): AiProvider & { lastReq?: AiChatRequest } {
  const self = {
    id,
    authKind: 'api_key' as const,
    lastReq: undefined as AiChatRequest | undefined,
    async getAuthStatus() {
      return { provider: id, authKind: 'api_key' as const, connected: true, label: id };
    },
    async listModels() {
      return [];
    },
    async streamChat(req: AiChatRequest, onEvent: (e: AiChatEvent) => void) {
      self.lastReq = req;
      onEvent({ kind: 'done', text: 'ok' });
    },
  };
  return self as unknown as AiProvider & { lastReq?: AiChatRequest };
}

describe('ProviderRegistry OCR fallback (G007/AC15)', () => {
  const keys = {} as never;

  it('OCRs images to text for a non-vision model and clears the images', async () => {
    const provider = capturingProvider('openrouter');
    const ocr = vi.fn(async () => 'RECOGNIZED TEXT');
    const reg = new ProviderRegistry(keys, { openrouter: provider } as ProviderMap, undefined, undefined, ocr);
    await reg.streamProviderChat(
      { instructions: 'i', history: [], userText: 'read this', model: { provider: 'openrouter', id: 'text-only' }, images: [img()] },
      () => {},
    );
    expect(ocr).toHaveBeenCalledTimes(1);
    expect(provider.lastReq?.images).toBeUndefined();
    expect(provider.lastReq?.userText).toContain('[Image OCR context]');
    expect(provider.lastReq?.userText).toContain('RECOGNIZED TEXT');
  });

  it('passes images through to a vision-capable model (no OCR)', async () => {
    const provider = capturingProvider('openrouter');
    const ocr = vi.fn(async () => 'X');
    const reg = new ProviderRegistry(keys, { openrouter: provider } as ProviderMap, undefined, undefined, ocr);
    await reg.streamProviderChat(
      { instructions: 'i', history: [], userText: 'describe', model: { provider: 'openrouter', id: 'openai/gpt-4o' }, images: [img()] },
      () => {},
    );
    expect(ocr).not.toHaveBeenCalled();
    expect(provider.lastReq?.images).toHaveLength(1);
  });

  it('surfaces an actionable error when OCR fails (never silently drops the image)', async () => {
    const provider = capturingProvider('ollama');
    const ocr = vi.fn(async () => {
      throw new Error('worker missing');
    });
    const reg = new ProviderRegistry(keys, { ollama: { ...provider, authKind: 'local' } as AiProvider } as ProviderMap, undefined, undefined, ocr);
    const events: AiChatEvent[] = [];
    await reg.streamProviderChat(
      { instructions: 'i', history: [], userText: 'x', model: { provider: 'ollama', id: 'llava' }, images: [img()] },
      (e) => events.push(e),
    );
    expect(events.at(-1)).toMatchObject({ kind: 'error', errorKind: 'provider' });
    expect((events.at(-1) as { message: string }).message).toContain('OCR failed');
  });
});

describe('package.json OCR bundling (G007/A2 extraResources)', () => {
  it('declares tesseract.js + extraResources for worker/core/lang-data', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    expect(pkg.dependencies['tesseract.js']).toBeTruthy();
    const extra: { from: string; to: string }[] = pkg.build.extraResources;
    expect(extra.some((e) => /worker\.min\.js/.test(e.from) && /tesseract\/worker/.test(e.to))).toBe(true);
    expect(extra.some((e) => /tesseract\.js-core/.test(e.from))).toBe(true);
    expect(extra.some((e) => /tessdata/.test(e.from) && /lang-data/.test(e.to))).toBe(true);
  });
});

describe('multimodal builders — image-only turn (G007 architect BLOCK fix)', () => {
  it('toAnthropicMessages keeps a trailing user turn for an image-only message', () => {
    const msgs = toAnthropicMessages([{ role: 'assistant', text: 'prev' }], '', [img()]);
    const last = msgs[msgs.length - 1];
    expect(last.role).toBe('user');
    expect(Array.isArray(last.content)).toBe(true);
    expect((last.content as any[]).some((p) => p.type === 'image')).toBe(true);
    expect((last.content as any[]).some((p) => p.type === 'text')).toBe(false); // no empty text part
  });

  it('openAiUserContent omits an empty text part for an image-only turn', () => {
    const content = openAiUserContent('', [img()]) as any[];
    expect(Array.isArray(content)).toBe(true);
    expect(content).toHaveLength(1);
    expect(content[0].type).toBe('image_url');
  });
});
