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

    (llama as HTMLButtonElement).click();
    expect(onBlockModelChange).toHaveBeenCalledWith('ollama:llama3:latest');
  });
});
