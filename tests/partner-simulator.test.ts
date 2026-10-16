import test from "node:test";
import assert from "node:assert/strict";
import { PartnerSimulator } from "../src/simulator/partner.js";

test("partner without idempotency creates duplicate effects for duplicate requests", () => {
  const partner = new PartnerSimulator({ idempotency: false, lookup: "authoritative" });
  partner.book({ shipmentRef: "SH-104", payloadHash: "h" });
  partner.book({ shipmentRef: "SH-104", payloadHash: "h" });
  assert.equal(partner.bookings.length, 2);
});

test("partner-enforced idempotency deduplicates the same key", () => {
  const partner = new PartnerSimulator({ idempotency: true, lookup: "none", idempotencyRetentionValid: true });
  const first = partner.book({ shipmentRef: "SH-104", payloadHash: "h", idempotencyKey: "stable-key" });
  const second = partner.book({ shipmentRef: "SH-104", payloadHash: "h", idempotencyKey: "stable-key" });
  assert.equal(partner.bookings.length, 1);
  assert.equal(first.bookingId, second.bookingId);
});

test("authoritative lookup can find a prior booking", () => {
  const partner = new PartnerSimulator({ idempotency: false, lookup: "authoritative" });
  const booking = partner.book({ shipmentRef: "SH-104", payloadHash: "h" });
  const result = partner.lookup("SH-104", "h");
  assert.equal(result.kind, "match");
  if (result.kind === "match") assert.equal(result.booking.bookingId, booking.bookingId);
});

test("eventual lookup cannot prove absence", () => {
  const partner = new PartnerSimulator({ idempotency: false, lookup: "eventual" });
  assert.equal(partner.lookup("SH-104", "h").kind, "weak_no_match");
});

test("same idempotency key is deduplicated by executeAttempt while retention is valid", () => {
  const partner = new PartnerSimulator({ idempotency: true, lookup: "none", idempotencyRetentionValid: true });
  const first = partner.executeAttempt({ actionId: "action-1", shipmentRef: "SH-104", payloadHash: "h", idempotencyKey: "stable-key" }, "none");
  const second = partner.executeAttempt({ actionId: "action-1", shipmentRef: "SH-104", payloadHash: "h", idempotencyKey: "stable-key" }, "none");
  assert.equal(partner.bookings.length, 1);
  assert.equal(first.groundTruth.createdNewBooking, true);
  assert.equal(second.groundTruth.createdNewBooking, false);
  assert.equal(first.groundTruth.bookingId, second.groundTruth.bookingId);
  assert.equal(second.observation.evidence[0]?.kind, "partner_success");
});

test("expired idempotency retention does not deduplicate the same key", () => {
  const partner = new PartnerSimulator({ idempotency: true, lookup: "none", idempotencyRetentionValid: false });
  partner.book({ shipmentRef: "SH-104", payloadHash: "h", idempotencyKey: "stable-key", causedByActionId: "action-1" });
  partner.book({ shipmentRef: "SH-104", payloadHash: "h", idempotencyKey: "stable-key", causedByActionId: "action-1" });
  assert.equal(partner.bookings.length, 2);
});

test("lost response observes a timeout while the partner ledger keeps the booking", () => {
  const partner = new PartnerSimulator({ idempotency: false, lookup: "authoritative" });
  const execution = partner.executeAttempt({ actionId: "action-1", shipmentRef: "SH-104", payloadHash: "h" }, "after_apply_before_response");
  assert.equal(execution.observation.evidence[0]?.kind, "transport_timeout");
  assert.equal(Object.hasOwn(execution.observation, "groundTruth"), false);
  assert.equal(execution.groundTruth.partnerApplied, true);
  assert.equal(partner.bookings.length, 1);
  assert.equal(partner.lookup("SH-104", "h").kind, "match");
});

test("definitive rejection creates no booking and is not a timeout", () => {
  const partner = new PartnerSimulator({ idempotency: false, lookup: "authoritative" });
  const execution = partner.executeAttempt({ actionId: "action-1", shipmentRef: "SH-104", payloadHash: "h" }, "definitive_rejection");
  assert.equal(execution.observation.evidence[0]?.kind, "definitive_rejection");
  assert.equal(partner.bookings.length, 0);
  assert.equal(execution.groundTruth.partnerApplied, false);
});

test("a hidden eventual booking is not returned as authoritative absence", () => {
  const partner = new PartnerSimulator({ idempotency: false, lookup: "eventual" });
  partner.book({ shipmentRef: "SH-104", payloadHash: "h", causedByActionId: "action-1", visibleToEventualLookup: false });
  assert.equal(partner.bookings.length, 1);
  assert.equal(partner.lookup("SH-104", "h").kind, "weak_no_match");
});

test("authoritative lookup reports multiple similar bookings as ambiguous", () => {
  const partner = new PartnerSimulator({ idempotency: false, lookup: "authoritative" });
  partner.book({ shipmentRef: "SH-104", payloadHash: "h", causedByActionId: "other" });
  partner.book({ shipmentRef: "SH-104", payloadHash: "h", causedByActionId: "action-1" });
  const result = partner.lookup("SH-104", "h");
  assert.equal(result.kind, "ambiguous");
  if (result.kind === "ambiguous") assert.equal(result.bookingIds.length, 2);
});
