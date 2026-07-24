import { describe, expect, it, vi } from 'vitest';
import { CalComCalendarProvider } from '../provider.js';

const options = { apiKey: 'k', eventTypeIdByService: { cleaning: 111 } };

describe('CalComCalendarProvider', () => {
  it('requires an api key and a mapped event type', async () => {
    expect(() => new CalComCalendarProvider({ apiKey: '', eventTypeIdByService: {} })).toThrow('apiKey');
    const provider = new CalComCalendarProvider({ ...options, fetchImpl: vi.fn() });
    await expect(
      provider.findAvailability({ serviceId: 'unknown', preferredStart: new Date(), durationMinutes: 30 }),
    ).rejects.toThrow('no eventTypeId mapped');
  });

  it('fetches and flattens availability slots sorted by start', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          status: 'success',
          data: {
            '2026-07-11': [{ start: '2026-07-11T09:00:00.000Z' }],
            '2026-07-10': [{ start: '2026-07-10T15:00:00.000Z' }, { start: '2026-07-10T16:00:00.000Z' }],
          },
        }),
        { status: 200 },
      ),
    );
    const provider = new CalComCalendarProvider({ ...options, fetchImpl });
    const slots = await provider.findAvailability({
      serviceId: 'cleaning',
      preferredStart: new Date('2026-07-10T15:00:00.000Z'),
      durationMinutes: 30,
    });
    expect(slots.map((s) => s.start.toISOString())).toEqual([
      '2026-07-10T15:00:00.000Z',
      '2026-07-10T16:00:00.000Z',
      '2026-07-11T09:00:00.000Z',
    ]);
    expect(slots[0]!.end.toISOString()).toBe('2026-07-10T15:30:00.000Z');
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toContain('/v2/slots?eventTypeId=111');
    expect(init.headers.Authorization).toBe('Bearer k');
  });

  it('creates a booking with attendee details and returns the confirmation', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          status: 'success',
          data: { uid: 'bk_abc', start: '2026-07-10T15:00:00.000Z', end: '2026-07-10T15:30:00.000Z' },
        }),
        { status: 201 },
      ),
    );
    const provider = new CalComCalendarProvider({ ...options, timeZone: 'America/New_York', fetchImpl });
    const confirmation = await provider.createBooking({
      serviceId: 'cleaning',
      start: new Date('2026-07-10T15:00:00.000Z'),
      durationMinutes: 30,
      customerName: 'Jane Doe',
      customerPhone: '+1 (555) 000-1111',
      notes: 'Booked by voice agent.',
    });
    expect(confirmation.bookingId).toBe('bk_abc');
    expect(confirmation.end.toISOString()).toBe('2026-07-10T15:30:00.000Z');
    const body = JSON.parse(fetchImpl.mock.calls[0]![1].body);
    expect(body.eventTypeId).toBe(111);
    expect(body.attendee.name).toBe('Jane Doe');
    expect(body.attendee.email).toBe('+15550001111@voice-agent.invalid');
    expect(body.attendee.timeZone).toBe('America/New_York');
  });

  it('throws descriptive errors on API failures', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('conflict', { status: 409 }));
    const provider = new CalComCalendarProvider({ ...options, fetchImpl });
    await expect(
      provider.createBooking({
        serviceId: 'cleaning',
        start: new Date(),
        durationMinutes: 30,
        customerName: 'J',
        customerPhone: '+1',
      }),
    ).rejects.toThrow('HTTP 409');
  });
});
