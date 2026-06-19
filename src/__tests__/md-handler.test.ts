import { describe, it, expect } from 'vitest';
import {
  mdHandlerStatus,
  isMdHandlerSupported,
  bundlePathFromExecPath,
  buildLsRegisterTarget,
  LSREGISTER_PATH,
} from '../main/md-handler';

describe('mdHandlerStatus (⑥ os-integration — packaged-darwin guard, AC9)', () => {
  it('is supported only for a packaged macOS build', () => {
    expect(mdHandlerStatus({ isPackaged: true, platform: 'darwin' })).toEqual({ supported: true });
  });

  it('is unsupported in dev (not packaged) even on macOS', () => {
    expect(mdHandlerStatus({ isPackaged: false, platform: 'darwin' }).supported).toBe(false);
  });

  it('is unsupported on non-darwin builds even when packaged', () => {
    expect(mdHandlerStatus({ isPackaged: true, platform: 'win32' }).supported).toBe(false);
    expect(mdHandlerStatus({ isPackaged: true, platform: 'linux' }).supported).toBe(false);
  });

  it('is unsupported when neither packaged nor darwin', () => {
    expect(mdHandlerStatus({ isPackaged: false, platform: 'linux' }).supported).toBe(false);
  });

  it('isMdHandlerSupported mirrors mdHandlerStatus.supported', () => {
    expect(isMdHandlerSupported({ isPackaged: true, platform: 'darwin' })).toBe(true);
    expect(isMdHandlerSupported({ isPackaged: false, platform: 'darwin' })).toBe(false);
    expect(isMdHandlerSupported({ isPackaged: true, platform: 'win32' })).toBe(false);
  });
});

describe('bundlePathFromExecPath', () => {
  it('derives the .app bundle root from a packaged macOS exec path', () => {
    expect(
      bundlePathFromExecPath('/Applications/Notepad AI.app/Contents/MacOS/Notepad AI'),
    ).toBe('/Applications/Notepad AI.app');
  });

  it('handles a relocated bundle path with spaces', () => {
    expect(
      bundlePathFromExecPath('/Users/x/Desktop/Notepad AI.app/Contents/MacOS/Notepad AI'),
    ).toBe('/Users/x/Desktop/Notepad AI.app');
  });

  it('returns null for a non-bundle executable (plain binary)', () => {
    expect(bundlePathFromExecPath('/usr/local/bin/electron')).toBeNull();
  });

  it('returns null for a bundle root missing the Contents/MacOS exec suffix', () => {
    expect(bundlePathFromExecPath('/Applications/Notepad AI.app')).toBeNull();
  });

  it('returns null for empty / non-string input', () => {
    expect(bundlePathFromExecPath('')).toBeNull();
    expect(bundlePathFromExecPath(undefined)).toBeNull();
    expect(bundlePathFromExecPath(null)).toBeNull();
    expect(bundlePathFromExecPath(42)).toBeNull();
  });
});

describe('buildLsRegisterTarget (idempotent, bundle-only)', () => {
  it('builds an idempotent (-f) lsregister invocation for a valid .app bundle', () => {
    expect(buildLsRegisterTarget('/Applications/Notepad AI.app')).toEqual({
      command: LSREGISTER_PATH,
      args: ['-f', '/Applications/Notepad AI.app'],
    });
  });

  it('uses -f so repeated calls update in place (no duplicate registrations / loops)', () => {
    const a = buildLsRegisterTarget('/Applications/Notepad AI.app');
    const b = buildLsRegisterTarget('/Applications/Notepad AI.app');
    expect(a).toEqual(b);
    expect(a?.args[0]).toBe('-f');
  });

  it('trims surrounding whitespace before building', () => {
    expect(buildLsRegisterTarget('  /Applications/Notepad AI.app  ')?.args[1]).toBe(
      '/Applications/Notepad AI.app',
    );
  });

  it('rejects non-.app, relative, empty, NUL, and non-string paths', () => {
    expect(buildLsRegisterTarget('/Applications/Notepad AI')).toBeNull(); // not an .app
    expect(buildLsRegisterTarget('Notepad AI.app')).toBeNull(); // relative
    expect(buildLsRegisterTarget('')).toBeNull();
    expect(buildLsRegisterTarget('   ')).toBeNull();
    expect(buildLsRegisterTarget('/Applications/Notepad\0AI.app')).toBeNull(); // NUL-poisoned
    expect(buildLsRegisterTarget(undefined)).toBeNull();
    expect(buildLsRegisterTarget(123)).toBeNull();
  });

  it('points at the system Launch Services lsregister tool', () => {
    expect(LSREGISTER_PATH).toContain('LaunchServices.framework');
    expect(LSREGISTER_PATH.endsWith('/lsregister')).toBe(true);
  });
});
