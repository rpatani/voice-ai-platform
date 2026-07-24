import type {
  AvailabilityRequest,
  AvailabilitySlot,
  BookingConfirmation,
  BookingRequest,
  ICalendarProvider,
} from '@platform/core';

/**
 * In-memory calendar for tests and simulation mode. Offers slots at the
 * caller's preferred time (plus one alternative an hour later) and records
 * bookings so tests can assert on them. Set `failNextBooking` to exercise
 * the engine's booking-failure path.
 */
export class MockCalendarProvider implements ICalendarProvider {
  readonly name = 'mock';
  readonly bookings: BookingRequest[] = [];
  failNextBooking = false;
  private bookingCounter = 0;

  async findAvailability(request: AvailabilityRequest): Promise<AvailabilitySlot[]> {
    const first = new Date(request.preferredStart);
    const second = new Date(first.getTime() + 60 * 60 * 1000);
    return [first, second].map((start) => ({
      start,
      end: new Date(start.getTime() + request.durationMinutes * 60 * 1000),
    }));
  }

  async createBooking(request: BookingRequest): Promise<BookingConfirmation> {
    if (this.failNextBooking) {
      this.failNextBooking = false;
      throw new Error('mock calendar: booking failed (simulated)');
    }
    this.bookings.push({ ...request });
    const bookingId = `mock-booking-${++this.bookingCounter}`;
    return {
      bookingId,
      start: request.start,
      end: new Date(request.start.getTime() + request.durationMinutes * 60 * 1000),
    };
  }
}
