import { describe, expect, it, vi } from 'vitest';

import { queueOrOpenFile, shouldPublishLaunchWindow, shouldUseMockKeychain } from '../main/lifecycle-flags';

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
describe('incoming file lifecycle', () => {
  it('queues a pre-ready file once for startup and opens ready files immediately', () => {
    const pending: string[] = [];
    const openFile = vi.fn();

    queueOrOpenFile(false, '/tmp/pre-ready.md', pending, openFile);

    expect(pending).toEqual(['/tmp/pre-ready.md']);
    expect(openFile).not.toHaveBeenCalled();

    for (const filePath of pending.splice(0)) openFile(filePath);
    expect(openFile).toHaveBeenCalledTimes(1);
    expect(openFile).toHaveBeenCalledWith('/tmp/pre-ready.md');

    queueOrOpenFile(true, '/tmp/ready.md', pending, openFile);

    expect(pending).toEqual([]);
    expect(openFile).toHaveBeenCalledTimes(2);
    expect(openFile).toHaveBeenLastCalledWith('/tmp/ready.md');
  });
});
