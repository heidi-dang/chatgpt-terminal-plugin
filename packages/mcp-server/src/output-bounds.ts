export const DEFAULT_MCP_CODE_OUTPUT_CHARACTERS = 6_000;
export const MIN_MCP_CODE_OUTPUT_CHARACTERS = 1_024;
export const MAX_MCP_CODE_OUTPUT_CHARACTERS = 65_536;

export interface BoundedOutputText {
  text: string;
  truncated: boolean;
  originalCharacters: number;
  omittedCharacters: number;
}

export interface LimitedProgressChunk {
  chunk: string;
  truncated: boolean;
}

function codePoints(value: string): string[] {
  return Array.from(value);
}

export function boundOutputText(text: string, maxCharacters: number): BoundedOutputText {
  if (!Number.isInteger(maxCharacters) || maxCharacters <= 0) {
    throw new RangeError('maxCharacters must be a positive integer.');
  }

  const characters = codePoints(text);
  const originalCharacters = characters.length;
  if (originalCharacters <= maxCharacters) {
    return { text, truncated: false, originalCharacters, omittedCharacters: 0 };
  }

  let omittedCharacters = originalCharacters - maxCharacters;
  let marker = '';
  let retainedCharacters = 0;

  for (let attempt = 0; attempt < 16; attempt += 1) {
    marker = `\n\n... [TRUNCATED ${omittedCharacters} CHARACTERS FOR MCP CONTEXT] ...\n\n`;
    retainedCharacters = Math.max(0, maxCharacters - codePoints(marker).length);
    const nextOmittedCharacters = originalCharacters - retainedCharacters;
    if (nextOmittedCharacters === omittedCharacters) break;
    omittedCharacters = nextOmittedCharacters;
  }

  marker = `\n\n... [TRUNCATED ${omittedCharacters} CHARACTERS FOR MCP CONTEXT] ...\n\n`;
  retainedCharacters = Math.max(0, maxCharacters - codePoints(marker).length);
  omittedCharacters = originalCharacters - retainedCharacters;

  const headCharacters = Math.ceil(retainedCharacters * 0.3);
  const tailCharacters = retainedCharacters - headCharacters;
  const head = characters.slice(0, headCharacters).join('');
  const tail = tailCharacters > 0 ? characters.slice(originalCharacters - tailCharacters).join('') : '';

  return {
    text: `${head}${marker}${tail}`,
    truncated: true,
    originalCharacters,
    omittedCharacters,
  };
}

export function createProgressChunkLimiter(maxCharacters: number): (chunk: string) => LimitedProgressChunk | null {
  if (!Number.isInteger(maxCharacters) || maxCharacters <= 0) {
    throw new RangeError('maxCharacters must be a positive integer.');
  }

  let remainingCharacters = maxCharacters;
  let truncationReported = false;

  return (chunk: string): LimitedProgressChunk | null => {
    const characters = codePoints(chunk);
    if (characters.length <= remainingCharacters) {
      remainingCharacters -= characters.length;
      return { chunk, truncated: false };
    }

    if (remainingCharacters > 0) {
      const boundedChunk = characters.slice(0, remainingCharacters).join('');
      remainingCharacters = 0;
      truncationReported = true;
      return { chunk: boundedChunk, truncated: true };
    }

    if (!truncationReported) {
      truncationReported = true;
      return { chunk: '', truncated: true };
    }

    return null;
  };
}
