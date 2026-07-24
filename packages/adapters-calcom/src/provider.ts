import type {
  AvailabilityRequest,
  AvailabilitySlot,
  BookingConfirmation,
  BookingRequest,
  ICalendarProvider,
} from '@platform/core';
import { providerErrorTotal, withSpan } from '@platform/observability';

export interface CalComOptions {
  apiKey: string;
  /** Maps platform service ids to Cal.com event type ids. */
  eventTypeIdByService: Record<string, number>;
  baseUrl?: string;
  /** Attendee timezone sent with bookings. */
  timeZone?: string;
  fetchImpl?: typeof fetch;
}

/**
 * `ICalendarProvider` over the Cal.com v2 API (plain fetch, no SDK).
 * Availability searches a window starting at the caller's preferred time;
 * bookings are created against the event type mapped from the service id.
 */
export class CalComCalendarProvider implements ICalendarProvider {
  readonly name = 'calcom';
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;

  constructor(private readonly options: CalComOptions) {
    if (!options.apiKey) throw new Error('calcom: apiKey is required');
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.baseUrl = options.baseUrl ?? 'https://api.cal.com';
  }

  private eventTypeId(serviceId: string): number {
    const id = this.options.eventTypeIdByService[serviceId];
    if (id === undefined) throw new Error(`calcom: no eventTypeId mapped for service "${serviceId}"`);
    return id;
  }

  async findAvailability(request: AvailabilityRequest): Promise<AvailabilitySlot[]> {
    return withSpan('calendar.findAvailability.request', async (span) => {
      span.setAttribute('calendar.provider', this.name);
      const eventTypeId = this.eventTypeId(request.serviceId);
      const start = request.preferredStart;
      // Search from the preferred time to 7 days out.
      const end = new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000);
      const params = new URLSearchParams({
        eventTypeId: String(eventTypeId),
        start: start.toISOString(),
        end: end.toISOString(),
      });
      const response = await this.fetchImpl(`${this.baseUrl}/v2/slots?${params}`, {
        headers: {
          Authorization: `Bearer ${this.options.apiKey}`,
          'cal-api-version': '2024-09-04',
        },
      });
      if (!response.ok) {
        providerErrorTotal.add(1, { provider: 'calcom', operation: 'findAvailability' });
        throw new Error(`calcom: slots HTTP ${response.status}`);
      }
      // v2 shape: { status, data: { "2026-07-10": [{ start: "..." }, ...] } }
      const json = (await response.json()) as { data?: Record<string, Array<{ start: string }>> };
      const slots: AvailabilitySlot[] = [];
      for (const day of Object.values(json.data ?? {})) {
        for (const slot of day) {
          const slotStart = new Date(slot.start);
          slots.push({
            start: slotStart,
            end: new Date(slotStart.getTime() + request.durationMinutes * 60 * 1000),
          });
        }
      }
      slots.sort((a, b) => a.start.getTime() - b.start.getTime());
      return slots.slice(0, 5);
    });
  }

  async createBooking(request: BookingRequest): Promise<BookingConfirmation> {
    return withSpan('calendar.createBooking.request', async (span) => {
      span.setAttribute('calendar.provider', this.name);
      const response = await this.fetchImpl(`${this.baseUrl}/v2/bookings`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.options.apiKey}`,
          'Content-Type': 'application/json',
          'cal-api-version': '2024-08-13',
        },
        body: JSON.stringify({
          eventTypeId: this.eventTypeId(request.serviceId),
          start: request.start.toISOString(),
          attendee: {
            name: request.customerName,
            // Cal.com requires an attendee contact; phone-first bookings use
            // a placeholder email derived from the phone number.
            email: `${request.customerPhone.replace(/[^0-9+]/g, '') || 'caller'}@voice-agent.invalid`,
            phoneNumber: request.customerPhone,
            timeZone: this.options.timeZone ?? 'UTC',
          },
          ...(request.notes ? { metadata: { notes: request.notes.slice(0, 500) } } : {}),
        }),
      });
      if (!response.ok) {
        providerErrorTotal.add(1, { provider: 'calcom', operation: 'createBooking' });
        const text = await response.text().catch(() => '');
        throw new Error(`calcom: booking HTTP ${response.status} ${text.slice(0, 300)}`);
      }
      const json = (await response.json()) as { data?: { uid?: string; id?: number; start?: string; end?: string } };
      const data = json.data ?? {};
      return {
        bookingId: data.uid ?? String(data.id ?? ''),
        start: data.start ? new Date(data.start) : request.start,
        end: data.end
          ? new Date(data.end)
          : new Date(request.start.getTime() + request.durationMinutes * 60 * 1000),
      };
    });
  }
}
