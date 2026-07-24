/** A single message in the conversation history sent to the LLM. */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** Present on 'tool' messages: which tool call this is a result for. */
  toolCallId?: string;
  /** Present on 'assistant' messages that requested tool calls. */
  toolCalls?: ToolCall[];
}

/** A request from the model to invoke one of the tools passed to `completeStream`. */
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** Describes a callable tool/function the model may choose to invoke. */
export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema describing the tool's arguments object. */
  parameters: Record<string, unknown>;
}

/** One chunk of a streamed LLM response. */
export interface LLMResponseChunk {
  /** Incremental text to append to the assistant's reply, if any. */
  deltaText?: string;
  /** Tool calls requested by the model, emitted once fully formed. */
  toolCalls?: ToolCall[];
  /** True on the final chunk of the stream. */
  finished: boolean;
}

/**
 * Abstraction over a chat-completion LLM provider (OpenAI, Anthropic, ...).
 * The conversation engine drives the dialogue through `completeStream`
 * (used for live turns, with tool calling for slot updates / booking
 * actions) and `complete` (used for non-streaming tasks like the
 * post-call summary).
 */
export interface ILLMProvider {
  readonly name: string;

  /** Stream a completion for the given conversation, with optional tools. */
  completeStream(messages: ChatMessage[], tools: ToolDefinition[]): AsyncIterable<LLMResponseChunk>;

  /** Non-streaming completion, used for summarization and classification tasks. */
  complete(messages: ChatMessage[]): Promise<string>;
}
