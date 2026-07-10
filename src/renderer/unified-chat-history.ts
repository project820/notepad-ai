/**
 * Unified chat history — pure merge/restore logic for the single collaborator
 * chat replacing the prior separate chat surfaces.
 *
 * Migration rule (locked): the primary legacy chat history comes first; the
 * secondary history is appended after a separator. Histories
 * are NOT interleaved (no reliable timestamps exist). All inputs are sanitized
 * so corrupt snapshots never crash restore.
 *
 * No I/O, no DOM — fully unit tested.
 */

export const LEGACY_SIDE_SEPARATOR = 'Legacy Side Chat';

export type LegacyTurn = { role: 'user' | 'assistant'; text: string };

export type UnifiedChatItem =
  | { type: 'message'; role: 'user' | 'assistant'; text: string; legacySource?: 'bottom' | 'side' }
  | { type: 'separator'; label: string };

export type UnifiedThreadSnapshot = {
  unifiedChatHistory?: unknown;
  /** Primary legacy chat history (persisted in older sessions as chatHistory). */
  chatHistory?: unknown;
  /** Secondary legacy chat history (often absent from older snapshots). */
  sideChatHistory?: unknown;
};

function isLegacyTurn(x: unknown): x is LegacyTurn {
  return (
    !!x &&
    typeof x === 'object' &&
    (((x as LegacyTurn).role === 'user') || ((x as LegacyTurn).role === 'assistant')) &&
    typeof (x as LegacyTurn).text === 'string'
  );
}

function asLegacyTurns(x: unknown): LegacyTurn[] {
  return Array.isArray(x) ? x.filter(isLegacyTurn) : [];
}

function isUnifiedItem(x: unknown): x is UnifiedChatItem {
  if (!x || typeof x !== 'object') return false;
  const item = x as { type?: unknown };
  if (item.type === 'separator') {
    return typeof (x as { label?: unknown }).label === 'string';
  }
  if (item.type === 'message') {
    return isLegacyTurn(x);
  }
  return false;
}

/**
 * Merge legacy bottom + side histories into a single unified thread.
 * Bottom first; side appended after a "Legacy Side Chat" separator. No interleave.
 */
export function mergeLegacyHistories(input: { bottom?: unknown; side?: unknown }): UnifiedChatItem[] {
  const bottom = asLegacyTurns(input.bottom);
  const side = asLegacyTurns(input.side);
  const items: UnifiedChatItem[] = bottom.map((t) => ({
    type: 'message',
    role: t.role,
    text: t.text,
    legacySource: 'bottom',
  }));
  if (side.length > 0) {
    items.push({ type: 'separator', label: LEGACY_SIDE_SEPARATOR });
    for (const t of side) {
      items.push({ type: 'message', role: t.role, text: t.text, legacySource: 'side' });
    }
  }
  return items;
}

/**
 * Restore a unified thread from a session snapshot. Prefers an already-migrated
 * `unifiedChatHistory`; otherwise merges legacy bottom (`chatHistory`) + side
 * (`sideChatHistory`). Always returns a valid (possibly empty) item array.
 */
export function restoreUnifiedThread(snap: UnifiedThreadSnapshot | null | undefined): UnifiedChatItem[] {
  if (!snap || typeof snap !== 'object') return [];
  if (Array.isArray(snap.unifiedChatHistory)) {
    return snap.unifiedChatHistory.filter(isUnifiedItem);
  }
  return mergeLegacyHistories({ bottom: snap.chatHistory, side: snap.sideChatHistory });
}

/** Extract just the chat turns (drop separators) for sending to a provider. */
export function threadToTurns(items: UnifiedChatItem[]): LegacyTurn[] {
  return items
    .filter((i): i is Extract<UnifiedChatItem, { type: 'message' }> => i.type === 'message')
    .map((i) => ({ role: i.role, text: i.text }));
}
