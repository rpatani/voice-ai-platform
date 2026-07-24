import { z } from 'zod';

export const weekdaySchema = z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);

export const businessHoursWindowSchema = z.object({
  day: weekdaySchema,
  open: z.string().regex(/^\d{2}:\d{2}$/, 'expected HH:MM'),
  close: z.string().regex(/^\d{2}:\d{2}$/, 'expected HH:MM'),
});

export const serviceDefinitionSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().default(''),
  durationMinutes: z.number().int().positive(),
});

export const providerSelectionSchema = z.object({
  telephony: z.string().min(1),
  stt: z.string().min(1),
  llm: z.string().min(1),
  tts: z.string().min(1),
  calendar: z.string().min(1),
});

export const escalationConfigSchema = z.object({
  transferNumber: z.string().optional(),
  maxRetriesPerSlot: z.number().int().positive().default(3),
});

/**
 * Schema for a single tenant's configuration file. This is the source of
 * truth validated by `FileTenantConfigProvider`; the resulting object
 * satisfies the `TenantConfig` interface from `@platform/core`.
 */
export const tenantConfigSchema = z.object({
  tenantId: z.string().min(1),
  displayName: z.string().min(1),
  inboundPhoneNumbers: z.array(z.string().min(1)).min(1),
  providers: providerSelectionSchema,
  providerOptions: z.record(z.string(), z.record(z.string(), z.unknown())).default({}),
  businessHours: z.array(businessHoursWindowSchema).default([]),
  services: z.array(serviceDefinitionSchema).default([]),
  systemPromptTemplate: z.string().min(1),
  escalation: escalationConfigSchema.default({ maxRetriesPerSlot: 3 }),
});

export type TenantConfigInput = z.input<typeof tenantConfigSchema>;
export type TenantConfigParsed = z.output<typeof tenantConfigSchema>;
