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

/** The markdown filename extensions we claim (mirrors CFBundleDocumentTypes). */
export const MARKDOWN_EXTENSIONS = ['md', 'markdown', 'mdx'] as const;

/**
 * Build the command that (best-effort) sets this app as the DEFAULT markdown
 * handler AND reports the bundle id that is actually the default afterwards.
 *
 * Why this shape (hard-won on macOS 26):
 *   - `lsregister` only makes the app a candidate ("Open With…"); it never sets
 *     the default. That was the original bug.
 *   - The old `LSSetDefaultRoleHandlerForContentType` returns noErr but is a
 *     silent no-op on current macOS.
 *   - The modern `NSWorkspace.setDefaultApplicationAtURL:toOpenContentType:` is
 *     the only real setter, but Launch Services refuses the write from a
 *     CLI/background (and for unsigned apps) — so it may not persist.
 * Therefore we ATTEMPT the modern set and then READ BACK the resolved default,
 * returning its bundle id. The caller compares it to our own id to decide whether
 * to report success or guide the one-time Finder step. AppleScriptObjC is used
 * because it can load `UniformTypeIdentifiers`/`UTType` (JXA cannot).
 *
 * `appBundlePath` is passed via argv (no shell, no string-escaping needed).
 */
export function buildApplyDefaultHandlerCommand(appBundlePath: string): LsRegisterTarget {
  const extList = MARKDOWN_EXTENSIONS.map((e) => `"${e}"`).join(', ');
  const cur = 'current application';
  const script = [
    'use framework "AppKit"',
    'use framework "UniformTypeIdentifiers"',
    'use scripting additions',
    'on run argv',
    '  set appPath to item 1 of argv',
    `  set ws to ${cur}'s NSWorkspace's sharedWorkspace`,
    `  set appURL to ${cur}'s NSURL's fileURLWithPath:appPath`,
    `  repeat with e in {${extList}}`,
    `    set ut to ${cur}'s UTType's typeWithFilenameExtension:(e as text)`,
    '    if ut is not missing value then',
    "      ws's setDefaultApplicationAtURL:appURL toOpenContentType:ut completionHandler:(missing value)",
    '    end if',
    '  end repeat',
    '  delay 1',
    `  set utmd to ${cur}'s UTType's typeWithFilenameExtension:"md"`,
    '  if utmd is missing value then return "no-uti"',
    "  set u to ws's URLForApplicationToOpenContentType:utmd",
    '  if u is missing value then return "none"',
    `  set b to ${cur}'s NSBundle's bundleWithURL:u`,
    '  if b is missing value then return "no-bundle"',
    "  set bid to b's bundleIdentifier",
    '  if bid is missing value then return "no-id"',
    '  return bid as text',
    'end run',
  ].join('\n');
  return { command: '/usr/bin/osascript', args: ['-e', script, appBundlePath] };
}
