import { randomUUID } from 'node:crypto';
import type {
  CallOutcome,
  ConversationState,
  ICallRepository,
  ICallSummaryRepository,
  ILeadRepository,
  ILLMProvider,
  ISessionStore,
  ISpeechToTextProvider,
  ISpeechToTextSession,
  ITelephonyCallSession,
  ITextToSpeechProvider,
  ITranscriptRepository,
  SynthesizeOptions,
  TenantConfig,
  ICalendarProvider,
} from '@platform/core';
import { createInitialConversationState, isTerminal } from '@platform/core';
import { callDurationMs, getLogger, providerErrorTotal, withSpan } from '@platform/observability';
import { ConversationEngine, type TurnResult } from '@platform/engine';

const logger = getLogger({ component: 'call-session' });

/** Final transcripts below this confidence trigger the fallback path. */
const DEFAULT_MIN_CONFIDENCE = 0.4;

export interface Repositories {
  calls: ICallRepository;
  transcripts: ITranscriptRepository;
  leads: ILeadRepository;
  summaries: ICallSummaryRepository;
}

export interface CallSessionDeps {
  telephony: ITelephonyCallSession;
  stt: ISpeechToTextProvider;
  llm: ILLMProvider;
  tts: ITextToSpeechProvider;
  calendar: ICalendarProvider;
  tenant: TenantConfig;
  repositories: Repositories;
  sessionStore: ISessionStore;
  fromNumber: string;
  toNumber: string;
  ttsOptions?: SynthesizeOptions;
  minConfidence?: number;
}

/**
 * Orchestrates one live call end-to-end: caller audio -> STT -> engine
 * (LLM + tools) -> TTS -> caller, plus barge-in, fallback/escalation,
 * persistence, and the post-call summary. One instance per call.
 */
export class CallSession {
  private readonly engine: ConversationEngine;
  private state: ConversationState;
  private sttSession: ISpeechToTextSession | null = null;
  private turnChain: Promise<void> = Promise.resolve();
  private speechChain: Promise<void> = Promise.resolve();
  private speakGeneration = 0;
  private speaking = false;
  private processingTurn = false;
  private closed = false;
  private endPromise: Promise<void> | null = null;
  private turnIndex = 0;
  private readonly startedAtMs = Date.now();
  private closedResolvers: Array<() => void> = [];

  constructor(private readonly deps: CallSessionDeps) {
    this.engine = new ConversationEngine({ llm: deps.llm, calendar: deps.calendar, tenant: deps.tenant });
    this.state = createInitialConversationState(deps.telephony.callId || randomUUID(), deps.tenant.tenantId);
  }

  /** Resolves once the call has fully ended and been persisted. */
  waitForClose(): Promise<void> {
    if (this.endPromise) return this.endPromise;
    return new Promise((resolve) => this.closedResolvers.push(resolve));
  }

  async start(): Promise<void> {
    await withSpan('call.start', async (span) => {
      span.setAttribute('tenant.id', this.deps.tenant.tenantId);
      span.setAttribute('call.id', this.state.callId);

      await this.deps.repositories.calls.create({
        callId: this.state.callId,
        tenantId: this.deps.tenant.tenantId,
        fromNumber: this.deps.fromNumber,
        toNumber: this.deps.toNumber,
        startedAt: new Date(),
        endedAt: null,
        outcome: 'in_progress',
        bookingId: null,
      });

      this.deps.telephony.onEnd(() => void this.end('caller_hangup'));

      this.sttSession = await this.deps.stt.startSession({ sampleRateHz: 8000, encoding: 'pcm16' });
      this.sttSession.onTranscript((event) => {
        // Any caller speech while the agent is talking = barge-in.
        if (this.speaking && event.text.trim()) this.bargeIn();
        if (!event.isFinal) return;
        this.enqueueTurn(event.text.trim(), event.confidence);
      });
      this.sttSession.onError((err) => {
        logger.error({ err, callId: this.state.callId }, 'stt session error; using fallback');
        providerErrorTotal.add(1, { provider: this.deps.stt.name, operation: 'stream' });
        this.enqueueTurn('', 0);
      });
      this.deps.telephony.onAudio((frame) => this.sttSession?.sendAudio(frame));

      // Greeting turn.
      this.turnChain = this.turnChain.then(async () => {
        try {
          const result = await this.engine.startCall(this.state, (s) => this.enqueueSpeech(s));
          await this.applyTurnResult(null, result);
        } catch (err) {
          logger.error({ err, callId: this.state.callId }, 'greeting failed');
          await this.handleTurnError();
        }
      });
      await this.turnChain;
    });
  }

  private enqueueTurn(text: string, confidence: number): void {
    this.turnChain = this.turnChain
      .then(() => this.processTurn(text, confidence))
      .catch((err) => logger.error({ err, callId: this.state.callId }, 'turn processing failed'));
  }

  private async processTurn(text: string, confidence: number): Promise<void> {
    if (this.closed || isTerminal(this.state)) return;
    this.processingTurn = true;
    try {
      let result: TurnResult;
      if (!text || confidence < (this.deps.minConfidence ?? DEFAULT_MIN_CONFIDENCE)) {
        result = this.engine.handleFallback(this.state);
        this.enqueueSpeech(result.reply);
      } else {
        try {
          result = await this.engine.handleUtterance(this.state, text, (s) => this.enqueueSpeech(s));
        } catch (err) {
          logger.error({ err, callId: this.state.callId }, 'engine turn failed; falling back');
          await this.handleTurnError();
          return;
        }
      }
      await this.applyTurnResult(text || null, result);
    } finally {
      this.processingTurn = false;
    }
  }

  private async handleTurnError(): Promise<void> {
    const result = this.engine.handleFallback(this.state);
    this.enqueueSpeech(result.reply);
    await this.applyTurnResult(null, result);
  }

  private async applyTurnResult(userText: string | null, result: TurnResult): Promise<void> {
    this.state = result.state;

    if (userText) await this.appendTranscript('user', userText);
    if (result.reply) await this.appendTranscript('assistant', result.reply);
    await this.deps.sessionStore.set(this.state.callId, this.state).catch((err) => {
      logger.warn({ err, callId: this.state.callId }, 'failed to persist session state');
    });

    if (result.escalated) {
      await this.speechChain;
      if (result.transferNumber) {
        try {
          await this.deps.telephony.transfer(result.transferNumber);
        } catch (err) {
          logger.error({ err, callId: this.state.callId }, 'transfer failed; hanging up');
          await this.speakNow(
            'I am sorry, I am unable to transfer you right now. Please call back later.',
            this.speakGeneration,
          );
          await this.deps.telephony.hangup().catch(() => {});
        }
      } else {
        await this.deps.telephony.hangup().catch(() => {});
      }
      await this.end('escalated');
      return;
    }

    if (result.endCall) {
      await this.speechChain;
      await this.deps.telephony.hangup().catch(() => {});
      await this.end('agent_hangup');
    }
  }

  /**
   * Queue a sentence for playback, serialized behind any current speech.
   * The generation captured at enqueue time means a barge-in cancels not
   * just the sentence being spoken but every queued sentence of that reply.
   */
  private enqueueSpeech(sentence: string): void {
    if (this.closed || !sentence) return;
    const generation = this.speakGeneration;
    this.speechChain = this.speechChain
      .then(() => this.speakNow(sentence, generation))
      .catch((err) => {
        providerErrorTotal.add(1, { provider: this.deps.tts.name, operation: 'synthesize' });
        logger.error({ err, callId: this.state.callId }, 'tts playback failed');
      });
  }

  private async speakNow(sentence: string, generation: number): Promise<void> {
    if (this.closed || generation !== this.speakGeneration) return; // barged in before playback
    this.speaking = true;
    try {
      for await (const frame of this.deps.tts.synthesizeStream(sentence, this.deps.ttsOptions)) {
        if (this.closed || generation !== this.speakGeneration) return; // barged in mid-sentence
        await this.deps.telephony.sendAudio(frame);
      }
    } finally {
      this.speaking = false;
    }
  }

  private bargeIn(): void {
    this.speakGeneration++;
    this.speaking = false;
    void this.deps.telephony.clearOutboundAudio().catch(() => {});
    logger.info({ callId: this.state.callId }, 'barge-in: cleared outbound audio');
  }

  private async appendTranscript(role: 'user' | 'assistant', text: string): Promise<void> {
    try {
      await this.deps.repositories.transcripts.append({
        callId: this.state.callId,
        tenantId: this.deps.tenant.tenantId,
        turnIndex: this.turnIndex++,
        role,
        text,
        timestamp: new Date(),
      });
    } catch (err) {
      logger.warn({ err, callId: this.state.callId }, 'failed to persist transcript turn');
    }
  }

  private outcome(): CallOutcome {
    if (this.state.bookingConfirmationId) return 'booked';
    if (this.state.step === 'escalated') return 'escalated';
    if (this.state.step === 'completed') return 'completed';
    return 'abandoned';
  }

  private end(reason: string): Promise<void> {
    if (this.endPromise) return this.endPromise;
    this.endPromise = this.doEnd(reason);
    return this.endPromise;
  }

  private async doEnd(reason: string): Promise<void> {
    this.closed = true;
    this.speakGeneration++;

    await withSpan('call.end', async (span) => {
      span.setAttribute('call.id', this.state.callId);
      span.setAttribute('call.end_reason', reason);
      const outcome = this.outcome();
      span.setAttribute('call.outcome', outcome);
      callDurationMs.record(Date.now() - this.startedAtMs, { tenant: this.deps.tenant.tenantId, outcome });

      await this.sttSession?.close().catch(() => {});

      try {
        await this.deps.repositories.calls.finalize(this.deps.tenant.tenantId, this.state.callId, {
          endedAt: new Date(),
          outcome,
          bookingId: this.state.bookingConfirmationId ?? null,
        });
      } catch (err) {
        logger.error({ err, callId: this.state.callId }, 'failed to finalize call record');
      }

      await this.persistLead();
      await this.persistSummary();
      await this.deps.sessionStore.delete(this.state.callId).catch(() => {});
      logger.info({ callId: this.state.callId, outcome, reason }, 'call ended');
    });

    for (const resolve of this.closedResolvers) resolve();
    this.closedResolvers = [];
  }

  /** Persist whatever caller details were collected, even on abandoned calls. */
  private async persistLead(): Promise<void> {
    const slots = this.state.slots;
    const hasAnything = Object.values(slots).some((s) => s.value !== null);
    if (!hasAnything) return;
    try {
      await this.deps.repositories.leads.create({
        leadId: randomUUID(),
        tenantId: this.deps.tenant.tenantId,
        callId: this.state.callId,
        callerName: slots.callerName.value,
        phoneNumber: slots.phoneNumber.value ?? this.deps.fromNumber,
        serviceNeed: slots.serviceNeed.value,
        preferredTime: slots.preferredTime.value,
        createdAt: new Date(),
      });
    } catch (err) {
      logger.error({ err, callId: this.state.callId }, 'failed to persist lead');
    }
  }

  /** Post-call summary via the non-streaming LLM path (M11). */
  private async persistSummary(): Promise<void> {
    const transcriptLines = this.state.history
      .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content)
      .map((m) => `${m.role === 'user' ? 'Caller' : 'Agent'}: ${m.content}`);
    if (transcriptLines.length === 0) return;
    try {
      const summary = await withSpan('llm.summarize', () =>
        this.deps.llm.complete([
          {
            role: 'system',
            content:
              'Summarize this phone call in 2-3 sentences for the business owner: who called, what they wanted, and the outcome (booked / escalated / incomplete).',
          },
          { role: 'user', content: transcriptLines.join('\n') },
        ]),
      );
      if (summary.trim()) {
        await this.deps.repositories.summaries.create({
          callId: this.state.callId,
          tenantId: this.deps.tenant.tenantId,
          summary: summary.trim(),
          createdAt: new Date(),
        });
      }
    } catch (err) {
      providerErrorTotal.add(1, { provider: this.deps.llm.name, operation: 'summarize' });
      logger.error({ err, callId: this.state.callId }, 'failed to generate call summary');
    }
  }
}
