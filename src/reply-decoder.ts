// Decode only the two string fields in the structured answer. Tokens and UTF-16
// pairs can cross notification boundaries; incomplete escapes never reach the UI.
export class ReplyDecoder {
  private state: 'start' | 'key' | 'colon' | 'value' | 'comma' | 'done' | 'invalid' = 'start';
  private reading: 'key' | 'value' | null = null;
  private key = '';
  private token = '';
  private escaped = false;
  private unicode: string | null = null;
  private high = '';
  private seen = new Set<string>();
  private prompt?: string;
  private answer = '';
  private answerStarted = false;

  push(chunk: string): { prompt?: string; answer: string } | undefined {
    for (const character of chunk) {
      if (this.state === 'invalid') break;
      if (this.reading) { this.string(character); continue; }
      if (/\s/.test(character)) continue;
      if (this.state === 'start' && character === '{') this.state = 'key';
      else if (this.state === 'key' && character === '"') this.begin('key');
      else if (this.state === 'colon' && character === ':') this.state = 'value';
      else if (this.state === 'value' && character === '"') {
        this.begin('value');
        if (this.key === 'answer') this.answerStarted = true;
      } else if (this.state === 'comma' && character === ',') this.state = 'key';
      else if ((this.state === 'comma' || this.state === 'key') && character === '}') this.state = 'done';
      else this.state = 'invalid';
    }
    return this.state === 'invalid' || (!this.answerStarted && this.prompt === undefined)
      ? undefined : { ...(this.prompt !== undefined && { prompt: this.prompt }), answer: this.answer };
  }

  private begin(reading: 'key' | 'value'): void {
    this.reading = reading; this.token = ''; this.high = ''; this.escaped = false; this.unicode = null;
  }
  private append(character: string): void {
    for (let index = 0; index < character.length; index++) {
      const unit = character[index], code = unit.charCodeAt(0);
      if (this.high) {
        if (code < 0xdc00 || code > 0xdfff) { this.state = 'invalid'; return; }
        this.token += this.high + unit; this.high = '';
      } else if (code >= 0xd800 && code <= 0xdbff) this.high = unit;
      else if (code >= 0xdc00 && code <= 0xdfff) { this.state = 'invalid'; return; }
      else this.token += unit;
    }
    if (this.reading === 'value' && this.key === 'answer') this.answer = this.token;
  }
  private string(character: string): void {
    if (this.unicode !== null) {
      if (!/^[a-f\d]$/i.test(character)) { this.state = 'invalid'; return; }
      this.unicode += character;
      if (this.unicode.length === 4) {
        this.append(String.fromCharCode(parseInt(this.unicode, 16))); this.unicode = null;
      }
      return;
    }
    if (this.escaped) {
      this.escaped = false;
      if (character === 'u') { this.unicode = ''; return; }
      const escapes: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
      if (!(character in escapes)) { this.state = 'invalid'; return; }
      this.append(escapes[character]); return;
    }
    if (character === '\\') { this.escaped = true; return; }
    if (character === '"') {
      if (this.high) { this.state = 'invalid'; return; }
      if (this.reading === 'key') {
        this.key = this.token;
        if (!['prompt', 'answer'].includes(this.key) || this.seen.has(this.key)) { this.state = 'invalid'; return; }
        this.seen.add(this.key); this.state = 'colon';
      } else {
        if (this.key === 'prompt') this.prompt = this.token;
        this.state = 'comma';
      }
      this.reading = null; return;
    }
    if (character.charCodeAt(0) < 32) { this.state = 'invalid'; return; }
    this.append(character);
  }
}
