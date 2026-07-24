import { describe, expect, it, vi } from 'vitest';
import type { ChatMessage, LLMResponseChunk } from '@platform/core';
import { OpenAiLlmProvider } from '../provider.js';

function sseResponse(lines: string[]): Response {
  const body = lines.map((l) => `data: ${l}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(body, { status: 200 });
}

async function collect(iterable: AsyncIterable<LLMResponseChunk>): Promise<LLMResponseChunk[]> {
  const chunks: LLMResponseChunk[] = [];
  for await (const chunk of iterable) chunks.push(chunk);
  return chunks;
}

const messages: ChatMessage[] = [
  { role: 'system', content: 'You are a helpful agent.' },
  { role: 'user', content: 'Hi' },
];

describe('OpenAiLlmProvider', () => {
  it('requires an api key', () => {
    expect(() => new OpenAiLlmProvider({ apiKey: '' })).toThrow('apiKey');
  });

  it('streams text deltas and a finished chunk', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      sseResponse([
        JSON.stringify({ choices: [{ delta: { content: 'Hello' } }] }),
        JSON.stringify({ choices: [{ delta: { content: ' there!' } }] }),
      ]),
    );
    const provider = new OpenAiLlmProvider({ apiKey: 'k', fetchImpl });
    const chunks = await collect(provider.completeStream(messages, []));
    expect(chunks.map((c) => c.deltaText).filter(Boolean).join('')).toBe('Hello there!');
    expect(chunks.at(-1)).toEqual({ toolCalls: undefined, finished: true });

    const [, init] = fetchImpl.mock.calls[0]!;
    const body = JSON.parse(init.body);
    expect(body.stream).toBe(true);
    expect(body.messages[0]).toEqual({ role: 'system', content: 'You are a helpful agent.' });
  });

  it('accumulates streamed tool call fragments into complete tool calls', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      sseResponse([
        JSON.stringify({
          choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'update_slot', arguments: '{"na' } }] } }],
        }),
        JSON.stringify({
          choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'me":"callerName","value":"Jane"}' } }] } }],
        }),
      ]),
    );
    const provider = new OpenAiLlmProvider({ apiKey: 'k', fetchImpl });
    const chunks = await collect(provider.completeStream(messages, [
      { name: 'update_slot', description: 'd', parameters: { type: 'object' } },
    ]));
    const final = chunks.at(-1)!;
    expect(final.finished).toBe(true);
    expect(final.toolCalls).toEqual([
      { id: 'call_1', name: 'update_slot', arguments: { name: 'callerName', value: 'Jane' } },
    ]);
    expect(JSON.parse(fetchImpl.mock.calls[0]![1].body).tools[0].function.name).toBe('update_slot');
  });

  it('recovers from malformed tool arguments with an empty object', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      sseResponse([
        JSON.stringify({
          choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'f', arguments: '{broken' } }] } }],
        }),
      ]),
    );
    const provider = new OpenAiLlmProvider({ apiKey: 'k', fetchImpl });
    const chunks = await collect(provider.completeStream(messages, []));
    expect(chunks.at(-1)!.toolCalls).toEqual([{ id: 'c1', name: 'f', arguments: {} }]);
  });

  it('serializes assistant tool calls and tool results in wire format', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(sseResponse([]));
    const provider = new OpenAiLlmProvider({ apiKey: 'k', fetchImpl });
    const history: ChatMessage[] = [
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'f', arguments: { a: 1 } }] },
      { role: 'tool', content: '{"ok":true}', toolCallId: 'c1' },
    ];
    await collect(provider.completeStream(history, []));
    const body = JSON.parse(fetchImpl.mock.calls[0]![1].body);
    expect(body.messages[0].tool_calls[0]).toEqual({
      id: 'c1',
      type: 'function',
      function: { name: 'f', arguments: '{"a":1}' },
    });
    expect(body.messages[0].content).toBeNull();
    expect(body.messages[1]).toEqual({ role: 'tool', content: '{"ok":true}', tool_call_id: 'c1' });
  });

  it('throws a descriptive error on non-2xx responses', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('rate limited', { status: 429 }));
    const provider = new OpenAiLlmProvider({ apiKey: 'k', fetchImpl });
    await expect(collect(provider.completeStream(messages, []))).rejects.toThrow('HTTP 429');
  });

  it('complete() returns the message content non-streaming', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: 'A summary.' } }] }), { status: 200 }),
    );
    const provider = new OpenAiLlmProvider({ apiKey: 'k', fetchImpl });
    expect(await provider.complete(messages)).toBe('A summary.');
    expect(JSON.parse(fetchImpl.mock.calls[0]![1].body).stream).toBe(false);
  });

  it('reuses the adapter for OpenAI-compatible backends (Groq) via baseUrl + providerLabel', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(sseResponse([]));
    const provider = new OpenAiLlmProvider({
      apiKey: 'gsk_x',
      model: 'llama-3.3-70b-versatile',
      baseUrl: 'https://api.groq.com/openai',
      providerLabel: 'groq',
      fetchImpl,
    });
    expect(provider.name).toBe('groq');
    await collect(provider.completeStream(messages, []));
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://api.groq.com/openai/v1/chat/completions');
    expect(JSON.parse(init.body).model).toBe('llama-3.3-70b-versatile');
    expect(init.headers.Authorization).toBe('Bearer gsk_x');
  });
});
