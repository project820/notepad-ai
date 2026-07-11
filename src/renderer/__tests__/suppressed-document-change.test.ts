import { describe, expect, it, vi } from 'vitest';
import { handleSuppressedDocumentChange } from '../suppressed-document-change';

describe('handleSuppressedDocumentChange', () => {
  it('schedules a session snapshot for a preview edit', () => {
    const scheduleSessionSnapshot = vi.fn();
    const syncPreview = vi.fn();
    const updateWordCount = vi.fn();
    const scheduleAutosave = vi.fn();
    const markDirty = vi.fn();

    handleSuppressedDocumentChange('preview edit', {
      isDirty: () => false,
      markDirty,
      syncPreview,
      updateWordCount,
      scheduleAutosave,
      scheduleSessionSnapshot,
    });

    expect(markDirty).toHaveBeenCalledOnce();
    expect(syncPreview).toHaveBeenCalledWith('preview edit');
    expect(scheduleSessionSnapshot).toHaveBeenCalledOnce();
  });

  it('schedules a session snapshot for an AI replacement', () => {
    const scheduleSessionSnapshot = vi.fn();

    handleSuppressedDocumentChange('AI replacement', {
      isDirty: () => true,
      markDirty: vi.fn(),
      updateWordCount: vi.fn(),
      scheduleAutosave: vi.fn(),
      scheduleSessionSnapshot,
    });

    expect(scheduleSessionSnapshot).toHaveBeenCalledOnce();
  });
});
