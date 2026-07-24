import type {
  ICalendarProvider,
  ILLMProvider,
  ISpeechToTextProvider,
  ITextToSpeechProvider,
  TenantConfig,
} from '@platform/core';
import { DeepgramSttProvider, DeepgramTtsProvider } from '@platform/adapters-deepgram';
import { OpenAiLlmProvider } from '@platform/adapters-openai';
import { ElevenLabsTtsProvider } from '@platform/adapters-elevenlabs';
import { CalComCalendarProvider } from '@platform/adapters-calcom';
import {
  MockCalendarProvider,
  MockLlmProvider,
  MockSttProvider,
  MockTtsProvider,
  type ScriptedLlmTurn,
} from '@platform/adapters-mock';
import type { AppEnv } from './env.js';

/**
 * Resolves each tenant's configured provider names into concrete adapter
 * instances. This is the single place vendor adapters are constructed;
 * everything downstream sees only `@platform/core` interfaces.
 *
 * Providers are created per call (STT/LLM sessions are stateful); the
 * registry itself is cheap and stateless.
 */
export class ProviderRegistry {
  constructor(private readonly env: AppEnv) {}

  private nameFor(tenant: TenantConfig, kind: keyof TenantConfig['providers']): string {
    return this.env.simulation ? 'mock' : tenant.providers[kind];
  }

  stt(tenant: TenantConfig): ISpeechToTextProvider {
    const name = this.nameFor(tenant, 'stt');
    switch (name) {
      case 'mock':
        return new MockSttProvider(optionsFor(tenant, 'mock-stt') as { utterances?: string[] });
      case 'deepgram': {
        if (!this.env.deepgramApiKey) throw new Error('stt provider "deepgram" requires DEEPGRAM_API_KEY');
        const opts = optionsFor(tenant, 'deepgram');
        return new DeepgramSttProvider({ apiKey: this.env.deepgramApiKey, model: opts['model'] as string | undefined });
      }
      default:
        throw new Error(`unknown stt provider: ${name}`);
    }
  }

  llm(tenant: TenantConfig): ILLMProvider {
    const name = this.nameFor(tenant, 'llm');
    switch (name) {
      case 'mock':
        return new MockLlmProvider(
          (optionsFor(tenant, 'mock-llm')['script'] as ScriptedLlmTurn[] | undefined) ?? DEFAULT_SIM_SCRIPT,
        );
      case 'openai': {
        if (!this.env.openaiApiKey) throw new Error('llm provider "openai" requires OPENAI_API_KEY');
        const opts = optionsFor(tenant, 'openai');
        return new OpenAiLlmProvider({ apiKey: this.env.openaiApiKey, model: opts['model'] as string | undefined });
      }
      case 'groq': {
        // Groq exposes an OpenAI-compatible chat completions API, so it
        // reuses the OpenAI-wire adapter pointed at Groq's base URL. Free tier.
        if (!this.env.groqApiKey) throw new Error('llm provider "groq" requires GROQ_API_KEY');
        const opts = optionsFor(tenant, 'groq');
        return new OpenAiLlmProvider({
          apiKey: this.env.groqApiKey,
          model: (opts['model'] as string | undefined) ?? 'llama-3.3-70b-versatile',
          baseUrl: this.env.groqBaseUrl ?? (opts['baseUrl'] as string | undefined) ?? 'https://api.groq.com/openai',
          providerLabel: 'groq',
        });
      }
      default:
        throw new Error(`unknown llm provider: ${name}`);
    }
  }

  tts(tenant: TenantConfig): ITextToSpeechProvider {
    const name = this.nameFor(tenant, 'tts');
    switch (name) {
      case 'mock':
        return new MockTtsProvider();
      case 'elevenlabs': {
        if (!this.env.elevenlabsApiKey) throw new Error('tts provider "elevenlabs" requires ELEVENLABS_API_KEY');
        const opts = optionsFor(tenant, 'elevenlabs');
        return new ElevenLabsTtsProvider({
          apiKey: this.env.elevenlabsApiKey,
          defaultVoiceId: opts['voiceId'] as string | undefined,
          model: opts['model'] as string | undefined,
        });
      }
      case 'deepgram': {
        // Deepgram Aura TTS - shares the Deepgram credential/free credit with
        // the STT adapter; the "voice" is selected via the model name.
        if (!this.env.deepgramApiKey) throw new Error('tts provider "deepgram" requires DEEPGRAM_API_KEY');
        const opts = optionsFor(tenant, 'deepgram-tts');
        return new DeepgramTtsProvider({
          apiKey: this.env.deepgramApiKey,
          model: opts['model'] as string | undefined,
        });
      }
      default:
        throw new Error(`unknown tts provider: ${name}`);
    }
  }

  calendar(tenant: TenantConfig): ICalendarProvider {
    const name = this.nameFor(tenant, 'calendar');
    switch (name) {
      case 'mock':
        return new MockCalendarProvider();
      case 'calcom': {
        if (!this.env.calcomApiKey) throw new Error('calendar provider "calcom" requires CALCOM_API_KEY');
        const opts = optionsFor(tenant, 'calcom');
        return new CalComCalendarProvider({
          apiKey: this.env.calcomApiKey,
          eventTypeIdByService: (opts['eventTypeIdByService'] as Record<string, number> | undefined) ?? {},
          timeZone: opts['timeZone'] as string | undefined,
        });
      }
      default:
        throw new Error(`unknown calendar provider: ${name}`);
    }
  }
}

function optionsFor(tenant: TenantConfig, provider: string): Record<string, unknown> {
  return tenant.providerOptions[provider] ?? {};
}

/**
 * Default scripted agent used in simulation mode when the tenant doesn't
 * supply its own script: a complete happy-path booking conversation.
 */
export const DEFAULT_SIM_SCRIPT: ScriptedLlmTurn[] = [
  { text: 'Hi, thanks for calling! Who do I have the pleasure of speaking with?' },
  {
    toolCalls: [{ id: 's1', name: 'update_slot', arguments: { name: 'callerName', value: 'Jane Doe', confirmed: true } }],
  },
  { text: 'Great to meet you, Jane. What is the best phone number to reach you?' },
  {
    toolCalls: [{ id: 's2', name: 'update_slot', arguments: { name: 'phoneNumber', value: '+15550001111', confirmed: true } }],
  },
  { text: 'Perfect. What service do you need?' },
  {
    toolCalls: [{ id: 's3', name: 'update_slot', arguments: { name: 'serviceNeed', value: 'cleaning', confirmed: true } }],
  },
  { text: 'And when would you like to come in?' },
  {
    toolCalls: [
      { id: 's4', name: 'update_slot', arguments: { name: 'preferredTime', value: 'tomorrow at 3pm', confirmed: true } },
      { id: 's5', name: 'check_availability', arguments: { serviceId: 'cleaning', preferredStartIso: '2026-07-06T15:00:00.000Z' } },
    ],
  },
  { text: 'We have 3pm tomorrow available. Shall I book it?' },
  {
    toolCalls: [{ id: 's6', name: 'book_appointment', arguments: { serviceId: 'cleaning', startIso: '2026-07-06T15:00:00.000Z' } }],
  },
  { text: 'You are all set for tomorrow at 3pm. Anything else?' },
  { text: 'Thanks for calling, goodbye!', toolCalls: [{ id: 's7', name: 'end_call', arguments: {} }] },
];
