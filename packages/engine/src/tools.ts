import type { TenantConfig, ToolDefinition } from '@platform/core';
import { SLOT_ORDER } from '@platform/core';

/** Tool definitions offered to the LLM on every conversational turn. */
export function buildToolDefinitions(tenant: TenantConfig): ToolDefinition[] {
  const serviceIds = tenant.services.map((s) => s.id);
  return [
    {
      name: 'update_slot',
      description:
        'Record a piece of information the caller provided (name, phone, service, preferred time). Set confirmed=true only after the caller has verified the read-back.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', enum: [...SLOT_ORDER] },
          value: { type: 'string' },
          confirmed: { type: 'boolean' },
        },
        required: ['name', 'value'],
      },
    },
    {
      name: 'check_availability',
      description: 'Find open appointment slots near the caller\'s preferred time. Call after all details are confirmed.',
      parameters: {
        type: 'object',
        properties: {
          serviceId: { type: 'string', enum: serviceIds },
          preferredStartIso: { type: 'string', description: 'Preferred start time, ISO 8601' },
        },
        required: ['serviceId', 'preferredStartIso'],
      },
    },
    {
      name: 'book_appointment',
      description: 'Create the booking at an offered time the caller accepted.',
      parameters: {
        type: 'object',
        properties: {
          serviceId: { type: 'string', enum: serviceIds },
          startIso: { type: 'string', description: 'Accepted start time, ISO 8601' },
        },
        required: ['serviceId', 'startIso'],
      },
    },
    {
      name: 'answer_faq',
      description: 'Look up factual business information (hours, services, description) to answer a caller question.',
      parameters: {
        type: 'object',
        properties: { question: { type: 'string' } },
        required: ['question'],
      },
    },
    {
      name: 'escalate_to_human',
      description: 'Transfer the caller to a human because they asked for one or you cannot help.',
      parameters: {
        type: 'object',
        properties: { reason: { type: 'string' } },
        required: ['reason'],
      },
    },
    {
      name: 'end_call',
      description: 'End the call after saying goodbye.',
      parameters: {
        type: 'object',
        properties: { reason: { type: 'string' } },
      },
    },
  ];
}
