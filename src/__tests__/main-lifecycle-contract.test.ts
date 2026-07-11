import { describe, expect, it } from 'vitest';

import { shouldPublishLaunchWindow, shouldUseMockKeychain } from '../main/lifecycle-flags';

describe('main integration keychain gate', () => {
  it('requires isolated userData and the exact integration-test marker', () => {
    expect(shouldUseMockKeychain({ NOTEPAD_AI_USERDATA: '/tmp/notepad-ai-test' })).toBe(false);
    expect(shouldUseMockKeychain({ NOTEPAD_AI_INTEGRATION_TEST: '1' })).toBe(false);
    expect(shouldUseMockKeychain({ NOTEPAD_AI_USERDATA: '/tmp/notepad-ai-test', NOTEPAD_AI_INTEGRATION_TEST: 'true' })).toBe(false);
    expect(shouldUseMockKeychain({ NOTEPAD_AI_USERDATA: '/tmp/notepad-ai-test', NOTEPAD_AI_INTEGRATION_TEST: '1' })).toBe(true);
  });
});

describe('launch-window publication', () => {
  it('does not promote a Cmd+N window into the open-file reuse target', () => {
    expect(shouldPublishLaunchWindow({})).toBe(false);
  });

  it('only publishes a blank lifecycle launch window', () => {
    expect(shouldPublishLaunchWindow({ isLaunchWindow: true })).toBe(true);
    expect(shouldPublishLaunchWindow({ isLaunchWindow: true, openFilePath: '/tmp/opened.md' })).toBe(false);
    expect(shouldPublishLaunchWindow({ isLaunchWindow: true, restore: {} })).toBe(false);
  });
});
