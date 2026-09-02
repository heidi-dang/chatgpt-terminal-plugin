import { describe, expect, it } from 'vitest';
import { boundOutputText, createProgressChunkLimiter } from '../../packages/mcp-server/src/output-bounds.js';

describe('MCP output bounds', () => {
  it('preserves output that already fits the configured bound', () => {
    const result = boundOutputText('hello', 10);
    expect(result).toEqual({
      text: 'hello',
      truncated: false,
      originalCharacters: 5,
      omittedCharacters: 0,
    });
  });

  it('returns a bounded head/tail excerpt with exact truncation accounting', () => {
    const source = `${'A'.repeat(2_000)}${'B'.repeat(8_000)}`;
    const result = boundOutputText(source, 6_000);

    expect(result.truncated).toBe(true);
    expect(result.originalCharacters).toBe(10_000);
    expect(result.omittedCharacters).toBe(10_000 - (6_000 - Array.from(`\n\n... [TRUNCATED ${result.omittedCharacters} CHARACTERS FOR MCP CONTEXT] ...\n\n`).length));
    expect(Array.from(result.text)).toHaveLength(6_000);
    expect(result.text.startsWith('A')).toBe(true);
    expect(result.text.endsWith('B'.repeat(100))).toBe(true);
    expect(result.text).toContain(`[TRUNCATED ${result.omittedCharacters} CHARACTERS FOR MCP CONTEXT]`);
  });

  it('does not split Unicode code points when producing an excerpt', () => {
    const source = `${'🙂'.repeat(900)}${'Z'.repeat(900)}`;
    const result = boundOutputText(source, 1_024);

    expect(result.truncated).toBe(true);
    expect(result.originalCharacters).toBe(1_800);
    expect(Array.from(result.text)).toHaveLength(1_024);
    expect(result.text).not.toContain('\uFFFD');
    expect(result.text.endsWith('Z')).toBe(true);
  });

  it('caps streamed progress across chunks and reports truncation once', () => {
    const limit = createProgressChunkLimiter(5);

    expect(limit('abc')).toEqual({ chunk: 'abc', truncated: false });
    expect(limit('de')).toEqual({ chunk: 'de', truncated: false });
    expect(limit('fgh')).toEqual({ chunk: '', truncated: true });
    expect(limit('ignored')).toBeNull();
  });

  it('truncates an oversized progress chunk at a Unicode-safe boundary', () => {
    const limit = createProgressChunkLimiter(3);
    expect(limit('🙂🙂🙂🙂')).toEqual({ chunk: '🙂🙂🙂', truncated: true });
    expect(limit('ignored')).toBeNull();
  });
});
