import { describe, expect, it } from 'vitest';
import { constructWithRollback } from '../../src/disposableStore';

describe('constructWithRollback', () => {
  it('disposes every staged resource in reverse when later construction throws', () => {
    const disposed: string[] = [];
    const constructionFailure = new Error('listener registration failed');

    expect(() => constructWithRollback((resources) => {
      resources.use({ dispose: () => disposed.push('renderer') });
      resources.use({ dispose: () => disposed.push('watcher') });
      resources.use({ dispose: () => disposed.push('listener') });
      throw constructionFailure;
    })).toThrow(constructionFailure);

    expect(disposed).toEqual(['listener', 'watcher', 'renderer']);
  });

  it('continues rollback when one staged disposer fails', () => {
    const disposed: string[] = [];
    const cleanupFailure = new Error('watcher disposal failed');
    const reported: unknown[] = [];

    expect(() => constructWithRollback((resources) => {
      resources.use({ dispose: () => disposed.push('renderer') });
      resources.use({
        dispose: () => {
          disposed.push('watcher');
          throw cleanupFailure;
        },
      });
      throw new Error('construction failed');
    }, (error) => reported.push(error))).toThrow('construction failed');

    expect(disposed).toEqual(['watcher', 'renderer']);
    expect(reported).toEqual([cleanupFailure]);
  });
});
