import type { TenantConfig } from '@platform/core';

/**
 * Operational rules appended to every tenant's prompt template. Tenant
 * templates control tone and business facts; this controls tool protocol
 * and voice-channel behavior, which must be consistent across tenants.
 */
export const OPERATIONAL_GUIDANCE = `
Rules for this phone conversation:
- You are on a live voice call. Keep replies to one or two short sentences. Ask one question at a time.
- Collect these details in order: caller name, phone number, service needed, preferred time.
- Every time the caller provides one of those details, call the update_slot tool with confirmed=false, then read it back to them.
- When the caller confirms a detail is correct, call update_slot again with confirmed=true.
- Once every detail is confirmed, recap the full request and ask for a final confirmation.
- After the final confirmation, call check_availability, offer the returned time, and on acceptance call book_appointment.
- Use answer_faq to look up business hours or service details when the caller asks.
- If the caller asks for a human, is upset, or you cannot help after two attempts, call escalate_to_human.
- When the conversation is finished (booked, or the caller is done), say goodbye and call end_call.
- Never invent availability, prices, or services. Never read tool JSON aloud - describe results naturally.`;

/** Render the tenant's system prompt template plus the operational rules. */
export function renderSystemPrompt(tenant: TenantConfig): string {
  const services = tenant.services
    .map((s) => `${s.name} (${s.durationMinutes} min)${s.description ? ` - ${s.description}` : ''}`)
    .join('; ');
  const businessHours = tenant.businessHours.map((w) => `${w.day} ${w.open}-${w.close}`).join(', ');
  const rendered = tenant.systemPromptTemplate
    .replaceAll('{{businessName}}', tenant.displayName)
    .replaceAll('{{services}}', services || 'none listed')
    .replaceAll('{{businessHours}}', businessHours || 'not specified');
  return `${rendered}\n${OPERATIONAL_GUIDANCE}`;
}
