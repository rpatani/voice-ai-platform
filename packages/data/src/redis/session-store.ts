import type { ConversationState, ISessionStore } from '@platform/core';

/**
 * Minimal shape of the redis v4 client we depend on. Declared structurally
 * so tests can inject a fake without a running Redis server.
 */
export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options?: { EX?: number }): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

/**
 * Redis-backed store for in-progress `ConversationState`. State is JSON;
 * `ConversationState` is plain serializable data by design (see
 * `@platform/core`), so no custom encoding is needed.
 */
export class RedisSessionStore implements ISessionStore {
  constructor(
    private readonly client: RedisLike,
    private readonly defaultTtlSeconds = 3600,
    private readonly keyPrefix = 'session:',
  ) {}

  async get(callId: string): Promise<ConversationState | null> {
    const raw = await this.client.get(this.keyPrefix + callId);
    return raw ? (JSON.parse(raw) as ConversationState) : null;
  }

  async set(callId: string, state: ConversationState, ttlSeconds?: number): Promise<void> {
    await this.client.set(this.keyPrefix + callId, JSON.stringify(state), {
      EX: ttlSeconds ?? this.defaultTtlSeconds,
    });
  }

  async delete(callId: string): Promise<void> {
    await this.client.del(this.keyPrefix + callId);
  }
}
