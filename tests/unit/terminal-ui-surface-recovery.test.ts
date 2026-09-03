// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { parseSurfaceId } from '../../packages/terminal-ui/src/main.js';

describe('terminal surface rollout recovery', () => {
  it('recovers a surface id from a partial terminal_start payload', () => {
    expect(parseSurfaceId({
      structuredContent: { surface_id: '11111111-1111-4111-8111-111111111111' },
    } as never)).toBe('11111111-1111-4111-8111-111111111111');
  });
});
