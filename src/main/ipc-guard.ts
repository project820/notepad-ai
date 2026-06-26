/**
 * ipc-guard.ts — trusted IPC registration wrappers (Phase 1 security gate).
 *
 * Every `ipcMain.handle` / `ipcMain.on` in the app must verify the sender is the
 * app's own top-level frame on a trusted origin before running. A compromised or
 * navigated renderer (or an injected subframe) must not be able to invoke the
 * powerful file/AI/session IPC surface.
 *
 * The trust decision itself lives in the pure, unit-tested `security.ts`
 * (`assertTrustedSenderShape` + `isTrustedAppUrl`); this module only maps a real
 * Electron event onto the testable shape, logs denials with a stable reason code,
 * and gates the handler.
 */

import { ipcMain } from 'electron';
import type { IpcMainInvokeEvent, IpcMainEvent } from 'electron';
import {
  assertTrustedSenderShape,
  SECURITY_REASON,
  type TrustedSenderShape,
} from './security';

type AnyIpcEvent = IpcMainInvokeEvent | IpcMainEvent;

const isDev = process.env.NODE_ENV === 'development';

/** Map a real Electron IPC event onto the pure trust-decision shape. */
function shapeOf(event: AnyIpcEvent): TrustedSenderShape {
  const frame = event.senderFrame ?? null;
  return {
    hasSenderFrame: frame !== null,
    // The app's document is always the top-level frame: a main frame has no parent.
    isMainFrame: frame !== null && frame.parent === null,
    frameUrl: frame?.url ?? null,
  };
}

/** Redact a frame URL for logging (origin only; never query/hash). */
function logOrigin(url: string | null): string {
  if (!url) return '(none)';
  try {
    return new URL(url).origin;
  } catch {
    return '(unparseable)';
  }
}

function denialLog(channel: string, event: AnyIpcEvent, reason: string): void {
  // Reason code + sender webContents id + origin only — no payload, no secrets.
  console.warn(
    `[ipc-guard] denied channel=${channel} reason=${reason} sender=${event.sender?.id ?? '?'} origin=${logOrigin(event.senderFrame?.url ?? null)}`,
  );
}

/**
 * Register an `invoke` handler that only runs for the trusted app main frame.
 * Untrusted senders are logged and rejected (the renderer's `invoke` rejects);
 * the trusted path is unaffected.
 */
export function handleTrusted<T>(
  channel: string,
  listener: (event: IpcMainInvokeEvent, ...args: any[]) => T | Promise<T>,
): void {
  ipcMain.handle(channel, async (event, ...args) => {
    const verdict = assertTrustedSenderShape(shapeOf(event), { isDev });
    if (!verdict.ok) {
      denialLog(channel, event, verdict.reason);
      throw new Error(`${SECURITY_REASON.IPC_UNTRUSTED_SENDER}:${channel}`);
    }
    return listener(event, ...args);
  });
}

/**
 * Register a fire-and-forget (`send`) listener that only runs for the trusted
 * app main frame. Untrusted senders are logged and dropped.
 */
export function onTrusted(
  channel: string,
  listener: (event: IpcMainEvent, ...args: any[]) => void,
): void {
  ipcMain.on(channel, (event, ...args) => {
    const verdict = assertTrustedSenderShape(shapeOf(event), { isDev });
    if (!verdict.ok) {
      denialLog(channel, event, verdict.reason);
      return;
    }
    listener(event, ...args);
  });
}
