// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { createToolbar, type ToolbarHandlers } from '../toolbar';

afterEach(() => {
  document.body.innerHTML = '';
});

describe('reasoning effort selector', () => {
  it('is hidden when the G5 capability snapshot contains no verified efforts', () => {
    document.body.innerHTML = '<div id="toolbar"></div><div id="navbar-controls"></div>';
    const handlers: ToolbarHandlers = {
      onFormat: () => {},
      onInsertTable: () => {},
      onTogglePreview: () => {},
      onToggleSideChat: () => {},
      onThemeChange: () => {},
      onFontSizeChange: () => {},
      onModelChange: () => {},
      onLocaleChange: () => {},
      onSignIn: () => {},
      onSignOut: () => {},
      getTheme: () => 'system',
      getFontSize: () => 'md',
      getModel: () => ({ provider: 'chatgpt', id: 'gpt-5.6-sol' }),
      getLocale: () => 'en',
      getAuth: () => ({ signedIn: false }),
      loadModels: async () => [],
      loadReasoningCapabilities: async () => ({
        featureEnabled: false,
        snapshotGeneration: 1,
        models: [],
        accountModels: [],
      }),
    };

    createToolbar(document.getElementById('toolbar')!, handlers);

    expect(document.querySelector('#hdr-reasoning')).toBeNull();
  });
});
