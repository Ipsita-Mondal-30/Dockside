import type { ActionEvidence, PartnerCapabilities } from "../domain/action.js";

export type Booking = {
  bookingId: string;
  shipmentRef: string;
  payloadHash: string;
  idempotencyKey?: string;
  causedByActionId?: string;
  visibleToEventualLookup: boolean;
};

export type FaultPoint =
  | "before_dispatch"
  | "after_receive_before_apply"
  | "after_apply_before_response"
  | "after_response_before_commit"
  | "definitive_rejection"
  | "none";

export type BookInput = {
  shipmentRef: string;
  payloadHash: string;
  idempotencyKey?: string;
  causedByActionId?: string;
  visibleToEventualLookup?: boolean;
};

export type AttemptRequest = {
  actionId: string;
  shipmentRef: string;
  payloadHash: string;
  idempotencyKey?: string;
  visibleToEventualLookup?: boolean;
};

/** What the runtime is allowed to observe. This object has no ground-truth fields. */
export type AttemptObservation = {
  evidence: ActionEvidence[];
};

/** Scorer-only record of what the partner actually did. Recovery policy must not read this. */
export type AttemptGroundTruth = {
  dispatchBoundaryCrossed: boolean;
  partnerApplied: boolean;
  responseReceived: boolean;
  responseCommitted: boolean;
  createdNewBooking: boolean;
  bookingId?: string;
};

export type AttemptExecution = {
  observation: AttemptObservation;
  groundTruth: AttemptGroundTruth;
};

export type LookupResult =
  | { kind: "match"; booking: Booking }
  | { kind: "no_match" }
  | { kind: "weak_no_match" }
  | { kind: "ambiguous"; bookingIds: string[] }
  | { kind: "unavailable" };

function hiddenTruth(overrides: Partial<AttemptGroundTruth> = {}): AttemptGroundTruth {
  return {
    dispatchBoundaryCrossed: false,
    partnerApplied: false,
    responseReceived: false,
    responseCommitted: false,
    createdNewBooking: false,
    ...overrides,
  };
}

export class PartnerSimulator {
  readonly bookings: Booking[] = [];
  private readonly idempotencyIndex = new Map<string, Booking>();
  private nextId = 1;

  constructor(readonly capabilities: PartnerCapabilities) {}

  book(input: BookInput): Booking {
    return this.apply(input).booking;
  }

  /**
   * Apply a partner call at an explicit lifecycle fault.
   * `observation` is safe to show the recovery policy. `groundTruth` is for scoring only.
   */
  executeAttempt(request: AttemptRequest, fault: FaultPoint): AttemptExecution {
    if (fault === "before_dispatch") {
      return {
        observation: { evidence: [{ kind: "dispatch_boundary_not_crossed" }] },
        groundTruth: hiddenTruth(),
      };
    }

    if (fault === "definitive_rejection") {
      return {
        observation: {
          evidence: [{
            kind: "definitive_rejection",
            reason: "Documented partner rejection with a no-effect guarantee",
          }],
        },
        groundTruth: hiddenTruth({
          dispatchBoundaryCrossed: true,
          responseReceived: true,
          responseCommitted: true,
        }),
      };
    }

    if (fault === "after_receive_before_apply") {
      return {
        observation: { evidence: [{ kind: "transport_timeout" }] },
        groundTruth: hiddenTruth({ dispatchBoundaryCrossed: true }),
      };
    }

    const applied = this.apply({
      shipmentRef: request.shipmentRef,
      payloadHash: request.payloadHash,
      ...(request.idempotencyKey ? { idempotencyKey: request.idempotencyKey } : {}),
      causedByActionId: request.actionId,
      visibleToEventualLookup: request.visibleToEventualLookup !== false,
    });

    if (fault === "after_apply_before_response") {
      return {
        observation: { evidence: [{ kind: "transport_timeout" }] },
        groundTruth: hiddenTruth({
          dispatchBoundaryCrossed: true,
          partnerApplied: true,
          createdNewBooking: applied.created,
          bookingId: applied.booking.bookingId,
        }),
      };
    }

    if (fault === "after_response_before_commit") {
      return {
        observation: { evidence: [{ kind: "local_commit_lost" }] },
        groundTruth: hiddenTruth({
          dispatchBoundaryCrossed: true,
          partnerApplied: true,
          responseReceived: true,
          createdNewBooking: applied.created,
          bookingId: applied.booking.bookingId,
        }),
      };
    }

    return {
      observation: { evidence: [{ kind: "partner_success", bookingId: applied.booking.bookingId }] },
      groundTruth: hiddenTruth({
        dispatchBoundaryCrossed: true,
        partnerApplied: true,
        responseReceived: true,
        responseCommitted: true,
        createdNewBooking: applied.created,
        bookingId: applied.booking.bookingId,
      }),
    };
  }

  lookup(shipmentRef: string, payloadHash: string): LookupResult {
    if (this.capabilities.lookup === "none") return { kind: "unavailable" };
    const matches = this.bookings.filter(booking => booking.shipmentRef === shipmentRef && booking.payloadHash === payloadHash);
    if (this.capabilities.lookup === "eventual") {
      const visible = matches.filter(booking => booking.visibleToEventualLookup);
      if (visible.length > 1) return { kind: "ambiguous", bookingIds: visible.map(booking => booking.bookingId) };
      if (visible.length === 1) return { kind: "match", booking: visible[0]! };
      return { kind: "weak_no_match" };
    }
    if (matches.length > 1) return { kind: "ambiguous", bookingIds: matches.map(booking => booking.bookingId) };
    if (matches.length === 1) return { kind: "match", booking: matches[0]! };
    return { kind: "no_match" };
  }

  private apply(input: BookInput): { booking: Booking; created: boolean } {
    if (input.idempotencyKey && this.capabilities.idempotency && this.capabilities.idempotencyRetentionValid === true) {
      const existing = this.idempotencyIndex.get(input.idempotencyKey);
      if (existing) return { booking: existing, created: false };
    }

    const booking: Booking = {
      bookingId: `booking-${this.nextId++}`,
      shipmentRef: input.shipmentRef,
      payloadHash: input.payloadHash,
      visibleToEventualLookup: input.visibleToEventualLookup !== false,
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      ...(input.causedByActionId ? { causedByActionId: input.causedByActionId } : {}),
    };
    this.bookings.push(booking);
    if (input.idempotencyKey && this.capabilities.idempotency && this.capabilities.idempotencyRetentionValid === true) {
      this.idempotencyIndex.set(input.idempotencyKey, booking);
    }
    return { booking, created: true };
  }
}
