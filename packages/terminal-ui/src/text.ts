const TERM_RE = /(^.*?[$#>]\s)([\w./:+-]+)?|(^\s*(?:\/\/|#\s)[^\n]*)|\b(ERROR|FAIL|FATAL|EXCEPTION)\b|\b(WARN(?:ING)?)\b|\b(PASS|SUCCESS|DONE|OK)\b|("[^"\n]*"|'[^'\n]*')|(--?[\w-]+)|((?:~|\.{1,2})?\/[^\s"';|&]+)|(\b\d+(?:\.\d+)?\b)|\b(const|let|var|function|class|if|else|for|while|return|import|from|export|async|await|new|true|false|null|undefined)\b/gim;
const TERM_KIND = ['', 'prompt', 'command', 'comment', 'error', 'warning', 'success', 'string', 'option', 'path', 'number', 'keyword'];

export interface TerminalNormalizationOptions {
  preserveCarriageReturns?: boolean;
}

export function normalizeTerminalText(input: string, options: TerminalNormalizationOptions = {}): string {
  let output = '';
  let index = 0;
  while (index < input.length) {
    const code = input.charCodeAt(index);
    if (code === 0x1b) {
      const next = input[index + 1];
      if (next === '[') {
        const start = index;
        index += 2;
        while (index < input.length) {
          const control = input.charCodeAt(index++);
          if (control >= 0x40 && control <= 0x7e) break;
        }
        const sequence = input.slice(start, index);
        if (options.preserveCarriageReturns && sequence.endsWith('m')) output += sequence;
        continue;
      }
      if (next === ']') {
        index += 2;
        while (index < input.length) {
          const control = input.charCodeAt(index);
          if (control === 0x07) {
            index += 1;
            break;
          }
          if (control === 0x1b && input[index + 1] === '\\') {
            index += 2;
            break;
          }
          index += 1;
        }
        continue;
      }
      index += Math.min(2, input.length - index);
      continue;
    }
    if (code === 0x08) {
      output = output.slice(0, -1);
      index += 1;
      continue;
    }
    if (code === 0x0d) {
      if (input.charCodeAt(index + 1) === 0x0a) {
        output += '\n';
        index += 2;
        continue;
      }
      output += options.preserveCarriageReturns ? '\r' : '\n';
      index += 1;
      continue;
    }
    if (code < 0x20 && code !== 0x09 && code !== 0x0a) {
      index += 1;
      continue;
    }
    output += input[index] ?? '';
    index += 1;
  }
  return output;
}

export function highlightTerminalText(doc: Document, input: string): DocumentFragment {
  const text = normalizeTerminalText(input);
  const out = doc.createDocumentFragment();
  let end = 0;
  const add = (value: string, kind: number) => {
    const span = doc.createElement('span');
    span.className = `term-${TERM_KIND[kind]}`;
    span.textContent = value;
    out.appendChild(span);
  };
  TERM_RE.lastIndex = 0;
  for (const match of text.matchAll(TERM_RE)) {
    const at = match.index ?? 0;
    if (at > end) out.append(text.slice(end, at));
    if (match[1]) {
      add(match[1], 1);
      if (match[2]) add(match[2], 2);
    } else {
      add(match[0], match.slice(1).findIndex(Boolean) + 1);
    }
    end = at + match[0].length;
  }
  if (end < text.length) out.append(text.slice(end));
  return out;
}

export function appendRichTerminalText(container: HTMLElement, input: string, overflow = false): number {
  const doc = container.ownerDocument;
  const out = doc.createDocumentFragment();
  const colors = 'black red green yellow blue magenta cyan white'.split(' ');
  let at = 0;
  let color = '';
  let bold = false;
  const add = (text: string) => {
    if (!text) return;
    const part = highlightTerminalText(doc, text);
    if (!color && !bold) out.appendChild(part);
    else {
      const span = doc.createElement('span');
      span.className = `${color ? `term-${color}` : ''}${bold ? ' term-bold' : ''}`;
      span.appendChild(part);
      out.appendChild(span);
    }
  };
  for (const match of input.matchAll(new RegExp(String.fromCharCode(27) + '\\[([0-9;]*)m', 'g'))) {
    const pos = match.index ?? 0;
    add(input.slice(at, pos));
    for (const code of (match[1] || '0').split(';').map(Number)) {
      if (!code) {
        color = '';
        bold = false;
      } else if (code === 1) bold = true;
      else if (code === 22) bold = false;
      else if (code === 39) color = '';
      else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) color = colors[code >= 90 ? code - 90 : code - 30] ?? '';
    }
    at = pos + match[0].length;
  }
  add(input.slice(at));
  const text = out.textContent ?? '';
  const reduced = doc.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  if (overflow && !reduced && !container.querySelector('.term-overflow') && text.length < 4096 && text.indexOf('\n') !== text.lastIndexOf('\n')) {
    const slot = doc.createElement('span');
    slot.className = 'term-overflow';
    slot.appendChild(out);
    container.appendChild(slot);
    setTimeout(() => slot.replaceWith(...slot.childNodes), 180);
    return text.length;
  }
  container.appendChild(out);
  return text.length;
}

export class TerminalOutputRenderer {
  private currentLineRaw = '';
  private currentLineText = '';
  private completedText = '';
  private currentLine: HTMLSpanElement;

  constructor(private readonly container: HTMLElement) {
    this.currentLine = this.createLine();
  }

  get text(): string {
    return `${this.completedText}${this.currentLineText}`;
  }

  get textLength(): number {
    return this.completedText.length + this.currentLineText.length;
  }

  reset(input = ''): void {
    this.container.textContent = '';
    this.currentLineRaw = '';
    this.currentLineText = '';
    this.completedText = '';
    this.currentLine = this.createLine();
    if (input) this.append(input);
  }

  append(input: string, overflow = false): number {
    if (!input) return 0;
    const before = this.textLength;
    const normalized = normalizeTerminalText(input, { preserveCarriageReturns: true });
    let index = 0;
    while (index < normalized.length) {
      if (normalized[index] === '\x1b' && normalized[index + 1] === '[') {
        const end = normalized.indexOf('m', index + 2);
        if (end >= 0) {
          this.currentLineRaw += normalized.slice(index, end + 1);
          index = end + 1;
          continue;
        }
      }
      const character = normalized[index] ?? '';
      if (character === '\r') {
        this.currentLineRaw = '';
        this.currentLineText = '';
        this.renderCurrentLine();
      } else if (character === '\n') {
        this.renderCurrentLine();
        this.completedText += `${this.currentLineText}\n`;
        this.container.appendChild(this.container.ownerDocument.createTextNode('\n'));
        this.currentLineRaw = '';
        this.currentLineText = '';
        this.currentLine = this.createLine();
      } else {
        this.currentLineRaw += character;
        this.currentLineText += character;
      }
      index += 1;
    }
    this.renderCurrentLine();
    if (overflow) this.animateCurrentAppend();
    return this.textLength - before;
  }

  trim(target: number, reason: 'mobile' | 'memory'): number {
    const fullText = this.text;
    if (fullText.length <= target) return 0;
    let tail = fullText.slice(-target);
    const newline = tail.indexOf('\n');
    if (newline >= 0) tail = tail.slice(newline + 1);
    const omitted = fullText.length - tail.length;
    const label = reason === 'mobile' ? 'for mobile performance' : 'to keep the live transcript responsive';
    this.reset(`[Older terminal output trimmed ${label}] ${omitted.toLocaleString()} characters omitted\n${tail}`);
    return omitted;
  }

  private createLine(): HTMLSpanElement {
    const line = this.container.ownerDocument.createElement('span');
    line.className = 'terminal-line';
    this.container.appendChild(line);
    return line;
  }

  private renderCurrentLine(): void {
    this.currentLine.textContent = '';
    appendRichTerminalText(this.currentLine, this.currentLineRaw);
  }

  private animateCurrentAppend(): void {
    const reduced = this.container.ownerDocument.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduced || this.currentLineText.length === 0) return;
    this.currentLine.classList.remove('terminal-line-flash');
    void this.currentLine.offsetWidth;
    this.currentLine.classList.add('terminal-line-flash');
  }
}