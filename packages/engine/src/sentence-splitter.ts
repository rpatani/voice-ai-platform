/**
 * Splits an incrementally-streamed LLM reply into complete sentences so TTS
 * synthesis can start before the full reply has arrived (major latency win
 * on voice). Feed deltas with `push`; call `flush` at end of stream for any
 * trailing partial sentence.
 */
export class SentenceSplitter {
  private buffer = '';

  push(delta: string): string[] {
    this.buffer += delta;
    const sentences: string[] = [];
    // Break after ., !, ? followed by whitespace - keeps abbreviations rare
    // enough for voice content that we accept the occasional early split.
    let match: RegExpExecArray | null;
    const boundary = /[.!?]["')\]]?\s+/g;
    let lastIndex = 0;
    while ((match = boundary.exec(this.buffer)) !== null) {
      const end = match.index + match[0].length;
      const sentence = this.buffer.slice(lastIndex, end).trim();
      if (sentence) sentences.push(sentence);
      lastIndex = end;
    }
    this.buffer = this.buffer.slice(lastIndex);
    return sentences;
  }

  flush(): string | null {
    const rest = this.buffer.trim();
    this.buffer = '';
    return rest.length > 0 ? rest : null;
  }
}
