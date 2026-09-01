import { describe, expect, it } from 'vitest';
import { pruneRateLimitBuckets, type RateLimitBucket } from '../../packages/mcp-server/src/http.js';

describe('HTTP bounded-memory helpers', () => {
  it('prunes rate-limit buckets from previous minutes while preserving the current minute', () => {
    const buckets = new Map<string, RateLimitBucket>([
      ['old-a', { minute: 100, count: 1 }],
      ['old-b', { minute: 101, count: 4 }],
      ['current-a', { minute: 102, count: 2 }],
      ['future-defensive', { minute: 103, count: 1 }],
    ]);

    pruneRateLimitBuckets(buckets, 102);

    expect([...buckets.keys()]).toEqual(['current-a', 'future-defensive']);
  });
});
