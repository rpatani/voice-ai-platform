/** A bookable service the tenant's business offers (e.g. "Oil change", "Dental cleaning"). */
export interface ServiceDefinition {
  id: string;
  name: string;
  description: string;
  durationMinutes: number;
}

export type Weekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';

export interface BusinessHoursWindow {
  day: Weekday;
  /** 24h "HH:MM" local time. */
  open: string;
  /** 24h "HH:MM" local time. */
  close: string;
}

/**
 * Names of the adapter implementations to use for this tenant, resolved by
 * the application's adapter registry at startup. Each name must correspond
 * to a registered implementation of the matching `I*Provider` interface -
 * this is the primary "no vendor lock-in" lever: changing a tenant's
 * provider is a config change, not a code change.
 */
export interface ProviderSelection {
  telephony: string;
  stt: string;
  llm: string;
  tts: string;
  calendar: string;
}

export interface EscalationConfig {
  /** Phone number to transfer to when the agent cannot help. Omit to disable transfer. */
  transferNumber?: string;
  /** Number of failed attempts on a single slot before escalating. */
  maxRetriesPerSlot: number;
}

/**
 * All configuration needed to run the voice agent for a single tenant
 * (a business using the platform). Resolved via `ITenantConfigProvider`
 * from the inbound phone number at the start of each call.
 */
export interface TenantConfig {
  tenantId: string;
  displayName: string;
  /** E.164 phone numbers this tenant receives calls on. */
  inboundPhoneNumbers: string[];
  providers: ProviderSelection;
  /** Provider-specific options keyed by provider name, e.g. voice IDs, model names. */
  providerOptions: Record<string, Record<string, unknown>>;
  businessHours: BusinessHoursWindow[];
  services: ServiceDefinition[];
  /** System prompt template (may contain {{businessName}}, {{services}}, etc. placeholders). */
  systemPromptTemplate: string;
  escalation: EscalationConfig;
}

/**
 * Multi-tenancy abstraction. The default implementation (in
 * `@platform/config`) reads from a local config store; a future
 * implementation could call a dedicated Tenant/Config microservice
 * shared across multiple agentic SaaS products without this interface
 * changing.
 */
export interface ITenantConfigProvider {
  /** Resolve a tenant from the number the caller dialed. Returns null if unknown. */
  resolveTenantByPhoneNumber(phoneNumber: string): Promise<TenantConfig | null>;

  /** Fetch a tenant's config by ID. Throws if the tenant does not exist. */
  getTenantConfig(tenantId: string): Promise<TenantConfig>;
}
