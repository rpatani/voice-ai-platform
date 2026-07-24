import { describe, expect, it } from 'vitest';
import type { TenantConfig } from '@platform/core';
import { ProviderRegistry } from '../registry.js';
import { loadEnv, type AppEnv } from '../env.js';

function tenant(overrides: Partial<TenantConfig> = {}): TenantConfig {
  return {
    tenantId: 't1',
    displayName: 'Test',
    inboundPhoneNumbers: ['+15550000000'],
    providers: { telephony: 'twilio', stt: 'deepgram', llm: 'groq', tts: 'deepgram', calendar: 'mock' },
    providerOptions: {},
    businessHours: [],
    services: [],
    systemPromptTemplate: 'x',
    escalation: { maxRetriesPerSlot: 3 },
    ...overrides,
  } as TenantConfig;
}

function env(overrides: Partial<AppEnv> = {}): AppEnv {
  const base = loadEnv({ SIMULATION: 'false' } as NodeJS.ProcessEnv);
  return { ...base, ...overrides };
}

describe('ProviderRegistry - free stack wiring', () => {
  it('constructs a Groq-backed LLM (OpenAI-compatible) labelled "groq"', () => {
    const registry = new ProviderRegistry(env({ groqApiKey: 'gsk_x' }));
    const llm = registry.llm(tenant({ providers: { ...tenant().providers, llm: 'groq' } }));
    expect(llm.name).toBe('groq');
  });

  it('requires GROQ_API_KEY for the groq provider', () => {
    const registry = new ProviderRegistry(env({ groqApiKey: undefined }));
    expect(() => registry.llm(tenant())).toThrow('GROQ_API_KEY');
  });

  it('constructs the Deepgram Aura TTS provider', () => {
    const registry = new ProviderRegistry(env({ deepgramApiKey: 'dg_x' }));
    const tts = registry.tts(tenant());
    expect(tts.name).toBe('deepgram');
  });

  it('requires DEEPGRAM_API_KEY for the deepgram TTS provider', () => {
    const registry = new ProviderRegistry(env({ deepgramApiKey: undefined }));
    expect(() => registry.tts(tenant())).toThrow('DEEPGRAM_API_KEY');
  });

  it('forces mock providers in simulation mode regardless of tenant config', () => {
    const registry = new ProviderRegistry(env({ simulation: true }));
    expect(registry.llm(tenant()).name).toBe('mock');
    expect(registry.tts(tenant()).name).toBe('mock');
    expect(registry.stt(tenant()).name).toBe('mock');
    expect(registry.calendar(tenant()).name).toBe('mock');
  });

  it('throws on an unknown provider name', () => {
    const registry = new ProviderRegistry(env());
    expect(() => registry.tts(tenant({ providers: { ...tenant().providers, tts: 'bogus' } }))).toThrow(
      'unknown tts provider: bogus',
    );
  });
});
