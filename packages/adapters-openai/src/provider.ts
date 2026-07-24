import type {
  ChatMessage,
  ILLMProvider,
  LLMResponseChunk,
  ToolCall,
  ToolDefinition,
} from '@platform/core';
import { getLogger, providerErrorTotal, withSpan } from '@platform/observability';

const logger = getLogger({ component: 'adapters-openai' });

export interface OpenAiOptions {
  apiKey: string;
  model?: string;
  /**
   * Override endpoint, e.g. for Azure OpenAI, a local proxy, or any
   * OpenAI-compatible gateway such as Groq (`https://api.groq.com/openai`),
   * OpenRouter, or Together.
   */
  baseUrl?: string;
  /**
   * Telemetry label for this provider (spans, error metric, `name`). Lets a
   * single OpenAI-wire adapter serve multiple compatible backends while
   * keeping traces/metrics attributable to the real vendor. Defaults to
   * "openai".
   */
  providerLabel?: string;
  temperature?: number;
  fetchImpl?: typeof fetch;
}

/** OpenAI wire format for a message (subset we produce). */
interface WireMessage {
  role: string;
  content: string | null;
  tool_call_id?: string;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
}

function toWireMessages(messages: ChatMessage[]): WireMessage[] {
  return messages.map((m) => {
    const wire: WireMessage = { role: m.role, content: m.content };
    if (m.role === 'tool' && m.toolCallId) wire.tool_call_id = m.toolCallId;
    if (m.role === 'assistant' && m.toolCalls?.length) {
      wire.tool_calls = m.toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
      }));
      if (wire.content === '') wire.content = null;
    }
    return wire;
  });
}

function toWireTools(tools: ToolDefinition[]) {
  return tools.map((t) => ({
    type: 'function' as const,
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

/**
 * `ILLMProvider` over OpenAI's chat completions HTTP API - plain `fetch` +
 * SSE parsing, no SDK. Streaming tool-call deltas are accumulated and
 * emitted once complete, matching the interface contract.
 */
export class OpenAiLlmProvider implements ILLMProvider {
  readonly name: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: OpenAiOptions) {
    if (!options.apiKey) throw new Error('openai: apiKey is required');
    this.name = options.providerLabel ?? 'openai';
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async request(body: Record<string, unknown>): Promise<Response> {
    const base = this.options.baseUrl ?? 'https://api.openai.com';
    const response = await this.fetchImpl(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.options.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.options.model ?? 'gpt-4o-mini',
        temperature: this.options.temperature ?? 0.3,
        ...body,
      }),
    });
    if (!response.ok) {
      providerErrorTotal.add(1, { provider: this.name, operation: 'chat' });
      const text = await response.text().catch(() => '');
      throw new Error(`openai: HTTP ${response.status} ${text.slice(0, 300)}`);
    }
    return response;
  }

  async *completeStream(messages: ChatMessage[], tools: ToolDefinition[]): AsyncIterable<LLMResponseChunk> {
    const response = await withSpan('llm.completeStream.request', async (span) => {
      span.setAttribute('llm.provider', this.name);
      span.setAttribute('llm.model', this.options.model ?? 'gpt-4o-mini');
      return this.request({
        messages: toWireMessages(messages),
        ...(tools.length > 0 ? { tools: toWireTools(tools) } : {}),
        stream: true,
      });
    });

    if (!response.body) throw new Error('openai: empty response body');

    // Accumulate tool call fragments by index; emit once the stream ends.
    const toolAccumulator = new Map<number, { id: string; name: string; args: string }>();
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newlineIndex: number;
        while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') continue;
          let parsed: {
            choices?: Array<{
              delta?: {
                content?: string;
                tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }>;
              };
            }>;
          };
          try {
            parsed = JSON.parse(data);
          } catch {
            logger.warn('openai: dropping malformed SSE data line');
            continue;
          }
          const delta = parsed.choices?.[0]?.delta;
          if (!delta) continue;
          if (delta.content) {
            yield { deltaText: delta.content, finished: false };
          }
          for (const tc of delta.tool_calls ?? []) {
            const entry = toolAccumulator.get(tc.index) ?? { id: '', name: '', args: '' };
            if (tc.id) entry.id = tc.id;
            if (tc.function?.name) entry.name += tc.function.name;
            if (tc.function?.arguments) entry.args += tc.function.arguments;
            toolAccumulator.set(tc.index, entry);
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    let toolCalls: ToolCall[] | undefined;
    if (toolAccumulator.size > 0) {
      toolCalls = [...toolAccumulator.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, entry]) => ({
          id: entry.id,
          name: entry.name,
          arguments: safeParseArgs(entry.args),
        }));
    }
    yield { toolCalls, finished: true };
  }

  async complete(messages: ChatMessage[]): Promise<string> {
    return withSpan('llm.complete', async (span) => {
      span.setAttribute('llm.provider', this.name);
      const response = await this.request({ messages: toWireMessages(messages), stream: false });
      const json = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
      return json.choices?.[0]?.message?.content ?? '';
    });
  }
}

function safeParseArgs(raw: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    logger.warn({ raw: raw.slice(0, 200) }, 'openai: tool call arguments were not valid JSON');
    return {};
  }
}
