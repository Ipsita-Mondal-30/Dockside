import type { PartnerCapabilities } from "../domain/action.js";
import type { FaultPoint } from "../simulator/partner.js";

export const SHIPMENT_REF = "SH-104";
export const PAYLOAD_HASH = "hash-1";

export type Scenario = {
  id: string;
  title: string;
  description: string;
  capabilities: PartnerCapabilities;
  fault: FaultPoint;
  unrelatedSimilarBookings: number;
  eventualIndexVisible: boolean;
  workers: number;
};

const noIdempotencyNoLookup: PartnerCapabilities = { idempotency: false, lookup: "none", idempotencyRetentionValid: false };
const reliableLookup: PartnerCapabilities = { idempotency: false, lookup: "authoritative", idempotencyRetentionValid: false };
const weakLookup: PartnerCapabilities = { idempotency: false, lookup: "eventual", idempotencyRetentionValid: false };
const idempotencyOnly: PartnerCapabilities = { idempotency: true, lookup: "none", idempotencyRetentionValid: true };

export const scenarios: Scenario[] = [
  {
    id: "S01",
    title: "Crash before send",
    description: "The worker crashes before dispatch. No partner effect exists. A later send is allowed only after the local journal shows the side-effect boundary was not crossed.",
    capabilities: reliableLookup,
    fault: "before_dispatch",
    unrelatedSimilarBookings: 0,
    eventualIndexVisible: true,
    workers: 1,
  },
  {
    id: "S02",
    title: "Request not applied; timeout",
    description: "The partner received the request and did not apply it. The client observed a timeout. Authoritative lookup proves no booking exists, so one retry can be authorized.",
    capabilities: reliableLookup,
    fault: "after_receive_before_apply",
    unrelatedSimilarBookings: 0,
    eventualIndexVisible: true,
    workers: 1,
  },
  {
    id: "S03",
    title: "Partner accepted; response lost",
    description: "The partner applied the booking and the response was lost. Authoritative lookup finds that booking. Dockside confirms success and does not create another.",
    capabilities: reliableLookup,
    fault: "after_apply_before_response",
    unrelatedSimilarBookings: 0,
    eventualIndexVisible: true,
    workers: 1,
  },
  {
    id: "S04",
    title: "Success received; local commit lost",
    description: "The partner applied the booking and the client received success, then crashed before persisting it. The lost commit is not success evidence. Lookup finds the booking and confirms it.",
    capabilities: reliableLookup,
    fault: "after_response_before_commit",
    unrelatedSimilarBookings: 0,
    eventualIndexVisible: true,
    workers: 1,
  },
  {
    id: "S05",
    title: "Definitive no-effect rejection",
    description: "The partner returned a documented rejection that guarantees no effect. This observation is not a timeout.",
    capabilities: reliableLookup,
    fault: "definitive_rejection",
    unrelatedSimilarBookings: 0,
    eventualIndexVisible: true,
    workers: 1,
  },
  {
    id: "S06",
    title: "Concurrent recovery",
    description: "Two workers recover the same action after a timeout where the booking was not applied. Both would authorize a retry from authoritative absence. The claim gate grants one dispatch.",
    capabilities: reliableLookup,
    fault: "after_receive_before_apply",
    unrelatedSimilarBookings: 0,
    eventualIndexVisible: true,
    workers: 2,
  },
  {
    id: "S07",
    title: "Weak lookup says no match",
    description: "The partner applied the booking, but the eventually consistent index does not show it yet. A weak not-found result does not authorize a retry.",
    capabilities: weakLookup,
    fault: "after_apply_before_response",
    unrelatedSimilarBookings: 0,
    eventualIndexVisible: false,
    workers: 1,
  },
  {
    id: "S08",
    title: "Multiple similar matches",
    description: "Authoritative lookup returns the action's booking and another similar record. Dockside escalates and does not create another booking.",
    capabilities: reliableLookup,
    fault: "after_apply_before_response",
    unrelatedSimilarBookings: 1,
    eventualIndexVisible: true,
    workers: 1,
  },
  {
    id: "S09",
    title: "Idempotency replay",
    description: "The partner applied the booking and the response was lost. The retry uses the same key inside the retention window. The partner simulator deduplicates that replay.",
    capabilities: idempotencyOnly,
    fault: "after_apply_before_response",
    unrelatedSimilarBookings: 0,
    eventualIndexVisible: true,
    workers: 1,
  },
  {
    id: "S10",
    title: "No idempotency and no lookup",
    description: "The partner applied the booking. The client cannot look it up and has no usable idempotency guarantee, so the ambiguous action is escalated and not retried.",
    capabilities: noIdempotencyNoLookup,
    fault: "after_apply_before_response",
    unrelatedSimilarBookings: 0,
    eventualIndexVisible: true,
    workers: 1,
  },
];
