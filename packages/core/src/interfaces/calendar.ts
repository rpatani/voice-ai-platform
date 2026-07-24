export interface AvailabilityRequest {
  serviceId: string;
  /** Caller's preferred start time. The provider should find the nearest open slot(s). */
  preferredStart: Date;
  durationMinutes: number;
}

export interface AvailabilitySlot {
  start: Date;
  end: Date;
}

export interface BookingRequest {
  serviceId: string;
  start: Date;
  durationMinutes: number;
  customerName: string;
  customerPhone: string;
  notes?: string;
}

export interface BookingConfirmation {
  /** Provider-specific booking/event identifier, read back to the caller. */
  bookingId: string;
  start: Date;
  end: Date;
}

/**
 * Abstraction over a booking/calendar backend (Cal.com, Google Calendar,
 * Calendly, or a generic webhook into a CRM). The conversation engine calls
 * this once all required slots are collected and confirmed.
 */
export interface ICalendarProvider {
  readonly name: string;

  /** Find open slots near the caller's preferred time. */
  findAvailability(request: AvailabilityRequest): Promise<AvailabilitySlot[]>;

  /** Create a confirmed booking. */
  createBooking(request: BookingRequest): Promise<BookingConfirmation>;
}
