import { app } from 'electron';
import { execFile } from 'node:child_process';
import { handleTrusted } from '../ipc-guard';
import {
  mdHandlerStatus,
  buildLsRegisterTarget,
  bundlePathFromExecPath,
  buildApplyDefaultHandlerCommand,
} from '../md-handler';

export function registerOsIpc(): void {
  handleTrusted('os:md-handler-status', async () => {
    const { supported } = mdHandlerStatus({ isPackaged: app.isPackaged, platform: process.platform });
    return { supported };
  });

  handleTrusted('os:register-md-handler', async () => {
    const { supported } = mdHandlerStatus({ isPackaged: app.isPackaged, platform: process.platform });
    if (!supported) return { ok: false, error: 'unsupported' };
    const bundlePath = bundlePathFromExecPath(app.getPath('exe'));
    const target = buildLsRegisterTarget(bundlePath);
    if (!target || !bundlePath) return { ok: false, error: 'bundle-not-found' };
    const runVoid = (cmd: string, args: string[]): Promise<void> =>
      new Promise((resolve, reject) => {
        execFile(cmd, args, (err) => (err ? reject(err) : resolve()));
      });
    const runCapture = (cmd: string, args: string[]): Promise<string> =>
      new Promise((resolve, reject) => {
        execFile(cmd, args, (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
      });
    const APP_BUNDLE_ID = 'com.notepad-ai.app';
    try {
      await runVoid(target.command, target.args);
      let defaultSet = false;
      try {
        const apply = buildApplyDefaultHandlerCommand(bundlePath);
        const resolved = (await runCapture(apply.command, apply.args)).trim();
        defaultSet = resolved === APP_BUNDLE_ID;
        console.log(`[md-handler] registered; default resolves to "${resolved}" (ours=${defaultSet})`);
      } catch (e) {
        console.log(`[md-handler] default check failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      return { ok: true, registered: true, defaultSet };
    } catch (e: any) {
      return { ok: false, error: e?.message ?? String(e) };
    }
  });
}
