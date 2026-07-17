// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { installBlockAi } from '../block-ai';
import { closeOpenMenu } from '../dropdown';
import { setLocale } from '../i18n';

const flush = () => new Promise((r) => setTimeout(r, 0));

function setGrokKeyStatus(connected: boolean) {
  (window as unknown as { api: unknown }).api = { aiGrokKeyStatus: vi.fn(async () => connected) };
}

const openViews: EditorView[] = [];

afterEach(() => {
  closeOpenMenu();
  // Destroy mounted views so CodeMirror cancels its deferred requestMeasure timer;
  // otherwise it fires post-teardown and throws an unhandled error (exit 1).
  for (const v of openViews.splice(0)) v.destroy();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.useRealTimers();
  setLocale('en');
  delete (window as unknown as { api?: unknown }).api;
});

function mount(over: {
  getBlockModel?: () => string | { provider: import('../../main/ai/types').AiProviderId; id: string } | undefined;
  loadModels?: (force?: boolean) => Promise<{ id: string; label?: string; provider?: string; contextWindow?: number }[]>;
} = {}) {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const view = new EditorView({ state: EditorState.create({ doc: 'hello world' }), parent });
  openViews.push(view);
  const previewEl = document.createElement('div');
  document.body.appendChild(previewEl);
  const onBlockModelChange = vi.fn();
  installBlockAi({
    view,
    previewEl,
    getModel: () => 'gpt-5.4-mini',
    getBlockModel: over.getBlockModel ?? (() => ({ provider: 'chatgpt', id: 'gpt-5.4-mini' })),
    onBlockModelChange,
    loadModels: over.loadModels ?? (async () => [
      { id: 'gpt-5.4-mini', label: 'GPT-5.4 mini', provider: 'chatgpt', contextWindow: 400_000 },
      { id: 'llama3:latest', label: 'llama3:latest', provider: 'ollama', contextWindow: 32_000 },
      { id: 'grok-4.5', label: 'Grok 4.5', provider: 'grok', contextWindow: 256_000 },
      { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', provider: 'claude', contextWindow: 200_000 },
    ]),
    getQuality: () => 'college',
  });
  return { view, onBlockModelChange };
}

describe('block-ai model menu (G003 local providers)', () => {
  it('lists local models with a provider+context hint and passes provider:id on select', async () => {
    const { view, onBlockModelChange } = mount();
    // Select text so Block AI activates, then open the popup via ⌘⇧A.
    view.dispatch({ selection: { anchor: 0, head: 5 } });
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', metaKey: true, shiftKey: true }));

    const modelBtn = document.querySelector<HTMLButtonElement>('#ba-model');
    expect(modelBtn).toBeTruthy();
    modelBtn!.click();
    await flush(); // deps.loadModels(true) resolves, menu builds

    const items = Array.from(document.querySelectorAll('.pm-item'));
    const llama = items.find((i) => i.getAttribute('data-value') === 'ollama:llama3:latest');
    expect(llama).toBeTruthy();
    expect(llama!.textContent).toContain('Ollama'); // provider label
    expect(llama!.textContent).toContain('32K'); // context badge
    const grok = items.find((i) => i.getAttribute('data-value') === 'grok:grok-4.5');
    expect(grok).toBeTruthy();
    expect(grok!.textContent).toContain('Grok');
    expect(items.find((i) => i.getAttribute('data-value') === 'claude:claude-sonnet-4-6')).toBeUndefined();

    (llama as HTMLButtonElement).click();
    expect(onBlockModelChange).toHaveBeenCalledWith('ollama:llama3:latest');
  });
  it('migrates a hidden persisted model to the first available model', async () => {
    const { view, onBlockModelChange } = mount({
      getBlockModel: () => ({ provider: 'grok', id: 'grok-composer-2.5-fast' }),
      loadModels: async () => [{ id: 'gpt-5.6', provider: 'chatgpt' }],
    });
    view.dispatch({ selection: { anchor: 0, head: 5 } });
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', metaKey: true, shiftKey: true }));

    Array.from(document.querySelectorAll<HTMLButtonElement>('#ba-model')).at(-1)!.click();
    await flush();

    expect(onBlockModelChange).toHaveBeenCalledTimes(1);
    expect(onBlockModelChange).toHaveBeenCalledWith('chatgpt:gpt-5.6');
  });

  it('does not migrate a visible persisted model', async () => {
    const { view, onBlockModelChange } = mount({
      getBlockModel: () => ({ provider: 'chatgpt', id: 'gpt-5.6' }),
      loadModels: async () => [{ id: 'gpt-5.6', provider: 'chatgpt' }],
    });
    view.dispatch({ selection: { anchor: 0, head: 5 } });
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', metaKey: true, shiftKey: true }));

    Array.from(document.querySelectorAll<HTMLButtonElement>('#ba-model')).at(-1)!.click();
    await flush();

    expect(onBlockModelChange).not.toHaveBeenCalled();
  });
  it('uses the forced fresh inventory when a composer selection becomes unavailable', async () => {
    const loadModels = vi.fn(async (_force?: boolean) => [{ id: 'gpt-5.6', provider: 'chatgpt' }]);
    const { view, onBlockModelChange } = mount({
      getBlockModel: () => ({ provider: 'grok', id: 'grok-composer-2.5-fast' }),
      loadModels,
    });
    view.dispatch({ selection: { anchor: 0, head: 5 } });
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', metaKey: true, shiftKey: true }));

    Array.from(document.querySelectorAll<HTMLButtonElement>('#ba-model')).at(-1)!.click();
    await flush();

    expect(loadModels).toHaveBeenCalledWith(true);
    expect(document.querySelector('[data-value="grok:grok-composer-2.5-fast"]')).toBeNull();
    expect(onBlockModelChange).toHaveBeenCalledTimes(1);
    expect(onBlockModelChange).toHaveBeenCalledWith('chatgpt:gpt-5.6');
  });
  it('opens from the cached inventory when a forced refresh stalls', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const { view, onBlockModelChange } = mount({
      getBlockModel: () => ({ provider: 'grok', id: 'grok-composer-2.5-fast' }),
      loadModels: () => {
        calls += 1;
        if (calls === 1) return Promise.resolve([{ id: 'gpt-5.6', provider: 'chatgpt' }]);
        return new Promise(() => {});
      },
    });

    await Promise.resolve();
    view.dispatch({ selection: { anchor: 0, head: 5 } });
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', metaKey: true, shiftKey: true }));
    Array.from(document.querySelectorAll<HTMLButtonElement>('#ba-model')).at(-1)!.click();
    await vi.advanceTimersByTimeAsync(1_500);

    expect(document.querySelector('[data-value="chatgpt:gpt-5.6"]')).not.toBeNull();
    expect(onBlockModelChange).toHaveBeenCalledTimes(1);
    expect(onBlockModelChange).toHaveBeenCalledWith('chatgpt:gpt-5.6');
  });
  it('keeps a persisted composer selection when the Grok key is present and refresh stalls', async () => {
    vi.useFakeTimers();
    let calls = 0;
    setGrokKeyStatus(true);
    const { view, onBlockModelChange } = mount({
      getBlockModel: () => ({ provider: 'grok', id: 'grok-composer-2.5-fast' }),
      loadModels: () => {
        calls += 1;
        return calls === 1
          ? Promise.resolve([{ id: 'grok-composer-2.5-fast', provider: 'grok' }])
          : new Promise(() => {});
      },
    });
    await Promise.resolve();
    view.dispatch({ selection: { anchor: 0, head: 5 } });
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', metaKey: true, shiftKey: true }));
    Array.from(document.querySelectorAll<HTMLButtonElement>('#ba-model')).at(-1)!.click();
    await vi.advanceTimersByTimeAsync(1_500);

    expect(document.querySelector('[data-value="grok:grok-composer-2.5-fast"]')).not.toBeNull();
    expect(onBlockModelChange).not.toHaveBeenCalled();
  });
  it('hides and migrates a cached composer selection when the Grok key was removed and refresh stalls', async () => {
    vi.useFakeTimers();
    setGrokKeyStatus(false);
    let calls = 0;
    const { view, onBlockModelChange } = mount({
      getBlockModel: () => ({ provider: 'grok', id: 'grok-composer-2.5-fast' }),
      loadModels: () => {
        calls += 1;
        return calls === 1
          ? Promise.resolve([
            { id: 'grok-composer-2.5-fast', provider: 'grok' },
            { id: 'gpt-5.6', provider: 'chatgpt' },
          ])
          : new Promise(() => {});
      },
    });
    await Promise.resolve();
    view.dispatch({ selection: { anchor: 0, head: 5 } });
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', metaKey: true, shiftKey: true }));
    Array.from(document.querySelectorAll<HTMLButtonElement>('#ba-model')).at(-1)!.click();
    await vi.advanceTimersByTimeAsync(1_500);

    expect(document.querySelector('[data-value="grok:grok-composer-2.5-fast"]')).toBeNull();
    expect(onBlockModelChange).toHaveBeenCalledTimes(1);
    expect(onBlockModelChange).toHaveBeenCalledWith('chatgpt:gpt-5.6');
  });
  it('shows composer from a fresh inventory', async () => {
    const { view } = mount({
      loadModels: async () => [{ id: 'grok-composer-2.5-fast', provider: 'grok' }],
    });
    view.dispatch({ selection: { anchor: 0, head: 5 } });
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', metaKey: true, shiftKey: true }));
    Array.from(document.querySelectorAll<HTMLButtonElement>('#ba-model')).at(-1)!.click();
    await flush();

    expect(document.querySelector('[data-value="grok:grok-composer-2.5-fast"]')).not.toBeNull();
  });
  it('migrates a composer selection while the startup snapshot remains unresolved when the Grok key is absent', async () => {
    vi.useFakeTimers();
    const { view, onBlockModelChange } = mount({
      getBlockModel: () => ({ provider: 'grok', id: 'grok-composer-2.5-fast' }),
      loadModels: () => new Promise(() => {}),
    });
    view.dispatch({ selection: { anchor: 0, head: 5 } });
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', metaKey: true, shiftKey: true }));
    Array.from(document.querySelectorAll<HTMLButtonElement>('#ba-model')).at(-1)!.click();
    await vi.advanceTimersByTimeAsync(1_500);

    expect(onBlockModelChange).toHaveBeenCalledWith('chatgpt:gpt-5.4-mini');
  });
});
// PR-2 (Bug A): mount block-ai with an injected openAiSettings + a stubbed
// window.api so we can drive the ai:chat error stream.
function mountAuth(
  openAiSettings: () => void,
  blockModel: { provider: import('../../main/ai/types').AiProviderId; id: string } = { provider: 'chatgpt', id: 'gpt-5.4-mini' },
) {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const view = new EditorView({ state: EditorState.create({ doc: 'hello world' }), parent });
  openViews.push(view);
  const previewEl = document.createElement('div');
  document.body.appendChild(previewEl);
  const aiChat = vi.fn(async (..._args: unknown[]) => {});
  let evCb: ((e: unknown) => void) | undefined;
  const onAiChatEvent = vi.fn((_id: string, cb: (e: unknown) => void) => {
    evCb = cb;
    return () => {};
  });
  (window as unknown as { api: unknown }).api = { aiChat, onAiChatEvent, aiCancel: vi.fn(async () => {}) };
  installBlockAi({
    view,
    previewEl,
    getModel: () => 'gpt-5.4-mini',
    getBlockModel: () => blockModel,
    onBlockModelChange: vi.fn(),
    loadModels: async () => [],
    getQuality: () => 'college',
    openAiSettings,
  });
  return { view, aiChat, emit: (e: unknown) => evCb?.(e) };
}

// Open the Block AI popup over a selection and click Generate. Resolves after the
// async generate() has registered its onAiChatEvent handler and called aiChat.
async function openAndGenerate(view: EditorView) {
  view.dispatch({ selection: { anchor: 0, head: 5 } });
  // Trigger THIS instance's popup via its own pill. A global ⌘⇧A keydown would also
  // fire stale document listeners left by earlier mounts in this file, opening a rival
  // popup whose deps lack openAiSettings.
  const pills = document.querySelectorAll<HTMLButtonElement>('.ba-pill');
  pills[pills.length - 1].click();
  const genBtn = document.querySelector<HTMLButtonElement>('#ba-generate');
  expect(genBtn).toBeTruthy();
  genBtn!.click();
  await flush();
}

describe('block-ai auth affordance (PR-2 Bug A)', () => {
  it('sends surfaceMode "block" and renders a DOM-built sign-in affordance for errorKind:auth without leaking the raw body', async () => {
    const openAiSettings = vi.fn();
    const { view, aiChat, emit } = mountAuth(openAiSettings);
    await openAndGenerate(view);

    expect(aiChat).toHaveBeenCalledTimes(1);
    expect(aiChat.mock.calls[0][0]).toMatchObject({
      model: { provider: 'chatgpt', id: 'gpt-5.4-mini' },
      surfaceMode: 'block',
    });

    // Auth error arrives carrying a hostile raw body that must never reach the DOM.
    const RAW = '<img src=x onerror="alert(1)">RAW_AUTH_LEAK';
    emit({ kind: 'error', errorKind: 'auth', message: RAW });

    const optionsEl = document.querySelector<HTMLDivElement>('#ba-options')!;
    // (a) a sign-in affordance/button is rendered.
    const signInBtn = optionsEl.querySelector<HTMLButtonElement>('.ba-signin');
    expect(signInBtn).toBeTruthy();
    expect(optionsEl.querySelector('.ba-auth-error')).toBeTruthy();
    // (d) built with textContent — fixed copy present, no markup parsed from the raw body.
    expect(optionsEl.querySelector('.ba-auth-msg')?.textContent).toBe(
      'Your ChatGPT session expired. Sign in again.',
    );
    expect(optionsEl.querySelector('img')).toBeNull();
    expect(optionsEl.innerHTML).not.toContain('onerror');
    // (b) the raw message text is NOT in the DOM.
    expect(document.body.textContent).not.toContain('RAW_AUTH_LEAK');
    // (c) clicking the button invokes the injected openAiSettings.
    signInBtn!.click();
    expect(openAiSettings).toHaveBeenCalledTimes(1);
  });
  it('renders localized English composer copy and the add-key affordance for a coded auth error', async () => {
    const openAiSettings = vi.fn();
    const { view, aiChat, emit } = mountAuth(
      openAiSettings,
      { provider: 'grok', id: 'grok-composer-2.5-fast' },
    );
    await openAndGenerate(view);

    expect(aiChat.mock.calls[0][0]).toMatchObject({
      model: { provider: 'grok', id: 'grok-composer-2.5-fast' },
      surfaceMode: 'block',
    });
    emit({
      kind: 'error',
      errorKind: 'auth',
      errorCode: 'grok_composer_requires_api_key',
      message: 'grok-composer-2.5-fast requires an xAI API key.',
    });

    const optionsEl = document.querySelector<HTMLDivElement>('#ba-options')!;
    const signInBtn = optionsEl.querySelector<HTMLButtonElement>('.ba-signin');
    expect(optionsEl.querySelector('.ba-auth-code')?.textContent).toBe(
      'Grok Composer requires an xAI API key. Add it in AI settings to use this model.',
    );
    expect(signInBtn).toBeTruthy();
    expect(optionsEl.querySelector('.ba-auth-msg')).toBeNull();
    expect(optionsEl.textContent).not.toContain('Your ChatGPT session expired. Sign in again.');
    expect(signInBtn?.textContent).toBe('Open AI settings');
    signInBtn!.click();
    expect(openAiSettings).toHaveBeenCalledTimes(1);
  });
  it('renders localized Korean composer copy and the add-key affordance for a coded auth error', async () => {
    setLocale('ko');
    const openAiSettings = vi.fn();
    const { view, emit } = mountAuth(
      openAiSettings,
      { provider: 'grok', id: 'grok-composer-2.5-fast' },
    );
    await openAndGenerate(view);

    emit({
      kind: 'error',
      errorKind: 'auth',
      errorCode: 'grok_composer_requires_api_key',
      message: 'grok-composer-2.5-fast requires an xAI API key.',
    });

    const optionsEl = document.querySelector<HTMLDivElement>('#ba-options')!;
    expect(optionsEl.querySelector('.ba-auth-code')?.textContent).toBe(
      'Grok Composer를 사용하려면 xAI API 키가 필요합니다. AI 설정에서 키를 추가하세요.',
    );
    expect(optionsEl.querySelector('.ba-signin')).toBeTruthy();
  });

  it('renders only localized coded copy for non-auth errors', async () => {
    const openAiSettings = vi.fn();
    const { view, emit } = mountAuth(openAiSettings);
    await openAndGenerate(view);

    emit({
      kind: 'error',
      errorKind: 'network',
      errorCode: 'grok_composer_requires_api_key',
      message: 'ignored by localized coded copy',
    });

    const optionsEl = document.querySelector<HTMLDivElement>('#ba-options')!;
    expect(optionsEl.querySelector('.ba-signin')).toBeNull();
    expect(optionsEl.querySelector('.ba-auth-error')).toBeNull();
    expect(optionsEl.querySelector('.ba-error')?.textContent).toBe(
      'Grok Composer requires an xAI API key. Add it in AI settings to use this model.',
    );
    expect(openAiSettings).not.toHaveBeenCalled();
  });
});
