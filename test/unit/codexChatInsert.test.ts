import { describe, expect, it, vi } from 'vitest';
import {
  formatExplorerResourcesAsMentionQueries,
  insertMentionsIntoCodex,
} from '../../src/codexChatInsert';

describe('Codex chat @ mention insertion', () => {
  it('formats files and directories as workspace-relative @ picker queries', () => {
    expect(formatExplorerResourcesAsMentionQueries([
      { relativePath: 'CHANGELOG.md', directory: false },
      { relativePath: 'scripts/lib', directory: true },
    ])).toEqual(['CHANGELOG.md', 'scripts/lib/']);
  });

  it('normalizes Windows path separators without Markdown encoding', () => {
    expect(formatExplorerResourcesAsMentionQueries([
      { relativePath: String.raw`docs\draft (old)`, directory: true },
    ])).toEqual(['docs/draft (old)/']);
  });

  it('focuses Codex and selects every query through the @ picker without sending', async () => {
    const events: string[] = [];
    const dependencies = {
      openCodexSidebar: vi.fn(async () => {
        events.push('open-sidebar');
      }),
      waitForFocus: vi.fn(async () => {
        events.push('wait');
      }),
      chooseMention: vi.fn(async (query: string) => {
        events.push(`mention:${query}`);
      }),
    };

    await insertMentionsIntoCodex(['CHANGELOG.md', 'scripts/lib/'], dependencies);

    expect(events).toEqual([
      'open-sidebar',
      'wait',
      'mention:CHANGELOG.md',
      'mention:scripts/lib/',
    ]);
  });
});
