/**
 * md-handler.ts — "default .md editor" OS-integration boundary (⑥ os-integration, AC9).
 *
 * Pure, unit-tested helpers for registering Notepad AI as a Markdown handler on
 * macOS. The actual side effect (spawning `lsregister`) lives in the main
 * process; everything here is a pure function so it can be tested in a plain
 * Node environment without Electron.
 *
 * Policy (Architect/Critic HIGH):
 *   - Only a *packaged macOS* build can register. dev (`electron .`) and every
 *     non-darwin build report `supported: false`, so the settings UI shows an
 *     explicit "unsupported" state instead of a silent no-op button.
 *   - Registration is user-initiated (explicit settings click) and idempotent —
 *     never on boot, never in a loop. The `-f` flag makes Launch Services update
 *     the existing registration in place rather than create duplicates.
 *   - `LSHandlerRank: Alternate` in the bundle plist (package.json build config)
 *     means the unsigned app only appears under Finder's "Open With…", never
 *     hijacking the user's existing .md editor (VS Code / Obsidian).
 */

export type MdHandlerEnv = {
  /** `app.isPackaged` — false when running the dev build (`electron .`). */
  isPackaged: boolean;
  /** `process.platform` — 'darwin' | 'win32' | 'linux' | … */
  platform: NodeJS.Platform;
};

export type MdHandlerStatus = {
  /** True only for a packaged macOS build — the one place registration works. */
  supported: boolean;
};

/** Absolute path to macOS Launch Services' `lsregister` tool. */
export const LSREGISTER_PATH =
  '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';

export type LsRegisterTarget = {
  /** Executable to spawn (never via a shell). */
  command: string;
  /** Argv for the executable. `-f` forces an idempotent re-registration. */
  args: string[];
};

/** Pure: may this build register itself as the default .md editor? */
export function mdHandlerStatus(env: MdHandlerEnv): MdHandlerStatus {
  return { supported: env.isPackaged === true && env.platform === 'darwin' };
}

/** Convenience boolean form of {@link mdHandlerStatus}. */
export function isMdHandlerSupported(env: MdHandlerEnv): boolean {
  return mdHandlerStatus(env).supported;
}

/**
 * Derive the `.app` bundle root from the running executable path.
 * A packaged macOS exec path looks like `…/Notepad AI.app/Contents/MacOS/Notepad AI`;
 * the bundle is the `…/Notepad AI.app` prefix. Returns `null` when the shape
 * does not match a macOS app-bundle executable, so the caller never spawns
 * `lsregister` against an untrusted target.
 */
export function bundlePathFromExecPath(execPath: unknown): string | null {
  if (typeof execPath !== 'string' || execPath.length === 0) return null;
  const marker = '.app/Contents/MacOS/';
  const idx = execPath.indexOf(marker);
  if (idx === -1) return null;
  return execPath.slice(0, idx + '.app'.length);
}

/**
 * Build the idempotent `lsregister` invocation that (re)registers an `.app`
 * bundle with Launch Services. Returns `null` for anything that is not a clean,
 * absolute `.app` bundle path.
 *
 * The `-f` flag makes repeated calls safe: Launch Services updates the existing
 * registration in place rather than creating duplicates, so clicking the
 * settings button more than once never loops or stacks registrations.
 */
export function buildLsRegisterTarget(bundlePath: unknown): LsRegisterTarget | null {
  if (typeof bundlePath !== 'string') return null;
  const p = bundlePath.trim();
  if (p.length === 0) return null;
  if (p.includes('\0')) return null; // reject NUL-poisoned paths
  if (!p.startsWith('/')) return null; // must be absolute
  if (!p.endsWith('.app')) return null; // must be an app bundle
  return { command: LSREGISTER_PATH, args: ['-f', p] };
}
