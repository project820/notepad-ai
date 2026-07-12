// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { installBlockAi } from '../block-ai';
import { closeOpenMenu } from '../dropdown';

const flush = () => new Promise((r) => setTimeout(r, 0));

const openViews: EditorView[] = [];

afterEach(() => {
  closeOpenMenu();
  // Destroy mounted views so CodeMirror cancels its deferred requestMeasure timer;
  // otherwise it fires post-teardown and throws an unhandled error (exit 1).
  for (const v of openViews.splice(0)) v.destroy();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

function mount() {
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
    getBlockModel: () => ({ provider: 'chatgpt', id: 'gpt-5.4-mini' }),
    onBlockModelChange,
    loadModels: async () => [
      { id: 'gpt-5.4-mini', label: 'GPT-5.4 mini', provider: 'chatgpt', contextWindow: 400_000 },
      { id: 'llama3:latest', label: 'llama3:latest', provider: 'ollama', contextWindow: 32_000 },
      { id: 'grok-4.5', label: 'Grok 4.5', provider: 'grok', contextWindow: 256_000 },
    ],
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

    (llama as HTMLButtonElement).click();
    expect(onBlockModelChange).toHaveBeenCalledWith('ollama:llama3:latest');
  });
});

// PR-2 (Bug A): mount block-ai with an injected openAiSettings + a stubbed
// window.api so we can drive the ai:chat error stream.
function mountAuth(openAiSettings: () => void) {
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
    getBlockModel: () => ({ provider: 'chatgpt', id: 'gpt-5.4-mini' }),
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

  it('keeps the escaped-innerHTML path for non-auth errors (no sign-in affordance)', async () => {
    const openAiSettings = vi.fn();
    const { view, emit } = mountAuth(openAiSettings);
    await openAndGenerate(view);

    emit({ kind: 'error', errorKind: 'network', message: 'boom-network' });

    const optionsEl = document.querySelector<HTMLDivElement>('#ba-options')!;
    expect(optionsEl.querySelector('.ba-signin')).toBeNull();
    expect(optionsEl.querySelector('.ba-auth-error')).toBeNull();
    expect(optionsEl.querySelector('.ba-error')?.textContent).toContain('boom-network');
    expect(openAiSettings).not.toHaveBeenCalled();
  });
});
