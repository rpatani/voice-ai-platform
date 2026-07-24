import type {
  ChatMessage,
  ILLMProvider,
  LLMResponseChunk,
  ToolCall,
  ToolDefinition,
} from '@platform/core';

/** One scripted assistant turn: text to stream and/or tool calls to request. */
export interface ScriptedLlmTurn {
  text?: string;
  toolCalls?: ToolCall[];
}

/**
 * Deterministic scripted LLM for tests and simulation mode. Each
 * `completeStream` call consumes the next scripted turn, streaming its text
 * word-by-word (exercising the sentence-splitting pipeline) and then
 * emitting its tool calls. `complete` returns `summaryText`.
 */
export class MockLlmProvider implements ILLMProvider {
  readonly name = 'mock';
  private turnIndex = 0;
  /** Every messages array passed to completeStream, for assertions. */
  readonly receivedMessages: ChatMessage[][] = [];
  readonly receivedTools: ToolDefinition[][] = [];

  constructor(
    private readonly script: ScriptedLlmTurn[],
    private readonly summaryText = 'Mock call summary.',
  ) {}

  async *completeStream(messages: ChatMessage[], tools: ToolDefinition[]): AsyncIterable<LLMResponseChunk> {
    this.receivedMessages.push(messages);
    this.receivedTools.push(tools);
    const turn = this.script[this.turnIndex++];
    if (!turn) {
      yield { deltaText: 'I am sorry, could you repeat that?', finished: false };
      yield { finished: true };
      return;
    }
    if (turn.text) {
      const words = turn.text.split(/(?<=\s)/);
      for (const word of words) {
        yield { deltaText: word, finished: false };
      }
    }
    yield { toolCalls: turn.toolCalls, finished: true };
  }

  async complete(_messages: ChatMessage[]): Promise<string> {
    return this.summaryText;
  }
}
