import { describe, expect, it } from 'vitest';
import config from '../../vitest.config';

describe('Vitest discovery configuration', () => {
  it('excludes project-local Git worktrees', () => {
    const resolved = config as { test?: { exclude?: string[] } };

    expect(resolved.test?.exclude).toContain('.worktrees/**');
  });
});
