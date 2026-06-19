import { describe, expect, it } from 'vitest';

import {
  LEGACY_SIDE_SEPARATOR,
  mergeLegacyHistories,
  restoreUnifiedThread,
  threadToTurns,
  type UnifiedChatItem,
} from '../unified-chat-history';

const bottom = [
  { role: 'user' as const, text: 'b-q' },
  { role: 'assistant' as const, text: 'b-a' },
];
const side = [
  { role: 'user' as const, text: 's-q' },
  { role: 'assistant' as const, text: 's-a' },
];

describe('mergeLegacyHistories', () => {
  it('bottom-only: produces messages tagged bottom, no separator', () => {
    const items = mergeLegacyHistories({ bottom });
    expect(items).toHaveLength(2);
    expect(items.every((i) => i.type === 'message' && i.legacySource === 'bottom')).toBe(true);
    expect(items.some((i) => i.type === 'separator')).toBe(false);
  });

  it('side-only: still emits a separator before side messages', () => {
    const items = mergeLegacyHistories({ side });
    expect(items[0]).toEqual({ type: 'separator', label: LEGACY_SIDE_SEPARATOR });
    expect(items.slice(1).every((i) => i.type === 'message' && i.legacySource === 'side')).toBe(true);
  });

  it('both: bottom first, then separator, then side (no interleave)', () => {
    const items = mergeLegacyHistories({ bottom, side });
    expect(items.map((i) => (i.type === 'separator' ? 'SEP' : `${i.legacySource}:${i.text}`))).toEqual([
      'bottom:b-q',
      'bottom:b-a',
      'SEP',
      'side:s-q',
      'side:s-a',
    ]);
  });

  it('empty inputs produce an empty thread', () => {
    expect(mergeLegacyHistories({})).toEqual([]);
  });

  it('tolerates corrupt entries (filters non-turn objects)', () => {
    const items = mergeLegacyHistories({
      bottom: [{ role: 'user', text: 'ok' }, { role: 'bogus', text: 'x' }, null, 42, { text: 'no role' }],
    });
    expect(items).toEqual([{ type: 'message', role: 'user', text: 'ok', legacySource: 'bottom' }]);
  });
});

describe('restoreUnifiedThread', () => {
  it('prefers an already-migrated unifiedChatHistory', () => {
    const unified: UnifiedChatItem[] = [
      { type: 'message', role: 'user', text: 'hi' },
      { type: 'separator', label: LEGACY_SIDE_SEPARATOR },
    ];
    expect(restoreUnifiedThread({ unifiedChatHistory: unified })).toEqual(unified);
  });

  it('falls back to merging legacy chatHistory + sideChatHistory', () => {
    const items = restoreUnifiedThread({ chatHistory: bottom, sideChatHistory: side });
    expect(items.filter((i) => i.type === 'separator')).toHaveLength(1);
    expect(items.filter((i) => i.type === 'message')).toHaveLength(4);
  });

  it('handles a legacy snapshot with only chatHistory (side unrecoverable)', () => {
    const items = restoreUnifiedThread({ chatHistory: bottom });
    expect(items).toHaveLength(2);
    expect(items.some((i) => i.type === 'separator')).toBe(false);
  });

  it('returns [] for null/garbage snapshots', () => {
    expect(restoreUnifiedThread(null)).toEqual([]);
    expect(restoreUnifiedThread(undefined)).toEqual([]);
    expect(restoreUnifiedThread({ unifiedChatHistory: 'nope' })).toEqual([]);
  });

  it('sanitizes a corrupt unifiedChatHistory array', () => {
    const items = restoreUnifiedThread({
      unifiedChatHistory: [
        { type: 'message', role: 'user', text: 'keep' },
        { type: 'separator' }, // missing label → dropped
        { type: 'message', role: 'x', text: 'drop' }, // bad role → dropped
        { type: 'separator', label: 'Keep Sep' },
      ],
    });
    expect(items).toEqual([
      { type: 'message', role: 'user', text: 'keep' },
      { type: 'separator', label: 'Keep Sep' },
    ]);
  });
});

describe('threadToTurns', () => {
  it('drops separators and keeps role/text turns', () => {
    const items = mergeLegacyHistories({ bottom, side });
    expect(threadToTurns(items)).toEqual([
      { role: 'user', text: 'b-q' },
      { role: 'assistant', text: 'b-a' },
      { role: 'user', text: 's-q' },
      { role: 'assistant', text: 's-a' },
    ]);
  });
});
