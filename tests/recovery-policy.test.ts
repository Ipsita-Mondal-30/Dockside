import test from "node:test";
import assert from "node:assert/strict";
import { decideRecovery } from "../src/policy/recovery-policy.js";
import type { PartnerCapabilities } from "../src/domain/action.js";

const none: PartnerCapabilities = { idempotency: false, lookup: "none", idempotencyRetentionValid: false };
const reliable: PartnerCapabilities = { idempotency: false, lookup: "authoritative", idempotencyRetentionValid: false };
const weak: PartnerCapabilities = { idempotency: false, lookup: "eventual", idempotencyRetentionValid: false };

test("authoritative match confirms success", () => {
  const result = decideRecovery("OUTCOME_UNKNOWN", reliable, [{ kind: "authoritative_match", bookingId: "b-1" }]);
  assert.equal(result.kind, "confirm_success");
});

test("authoritative no-match can authorize retry", () => {
  const result = decideRecovery("RECONCILING", reliable, [{ kind: "authoritative_no_match" }]);
  assert.equal(result.kind, "authorize_retry");
});

test("weak no-match does not authorize retry", () => {
  const result = decideRecovery("OUTCOME_UNKNOWN", weak, [{ kind: "weak_no_match" }]);
  assert.equal(result.kind, "keep_unknown");
});

test("no idempotency and no lookup escalates ambiguous outcome", () => {
  const result = decideRecovery("OUTCOME_UNKNOWN", none, [{ kind: "transport_timeout" }]);
  assert.equal(result.kind, "escalate");
});

test("multiple matches escalate instead of guessing", () => {
  const result = decideRecovery("RECONCILING", reliable, [{ kind: "lookup_ambiguous", candidateIds: ["b-1", "b-2"] }]);
  assert.equal(result.kind, "escalate");
});

test("partner-enforced idempotency permits same-key retry", () => {
  const caps: PartnerCapabilities = { idempotency: true, lookup: "none", idempotencyRetentionValid: true };
  const result = decideRecovery("OUTCOME_UNKNOWN", caps, [{ kind: "transport_timeout" }]);
  assert.equal(result.kind, "authorize_retry");
  if (result.kind === "authorize_retry") assert.equal(result.useSameIdempotencyKey, true);
});

test("idempotency outside retention window is not trusted", () => {
  const caps: PartnerCapabilities = { idempotency: true, lookup: "none", idempotencyRetentionValid: false };
  const result = decideRecovery("OUTCOME_UNKNOWN", caps, [{ kind: "transport_timeout" }]);
  assert.equal(result.kind, "escalate");
});

test("request sent or timeout is not evidence of success", () => {
  const result = decideRecovery("OUTCOME_UNKNOWN", reliable, [{ kind: "transport_timeout" }]);
  assert.equal(result.kind, "keep_unknown");
});

test("policy refuses to resolve an unrelated state", () => {
  const result = decideRecovery("READY", reliable, []);
  assert.equal(result.kind, "escalate");
});

test("READY, confirmed success, and escalated are not resolved by recovery", () => {
  const success = [{ kind: "authoritative_match" as const, bookingId: "b-1" }];
  for (const state of ["READY", "CONFIRMED_SUCCEEDED", "ESCALATED"] as const) {
    assert.equal(decideRecovery(state, reliable, success).kind, "escalate");
  }
});

test("definitive rejection confirms non-execution and is distinct from a timeout", () => {
  const rejection = decideRecovery("OUTCOME_UNKNOWN", reliable, [{ kind: "definitive_rejection", reason: "validation failed" }]);
  const timeout = decideRecovery("OUTCOME_UNKNOWN", reliable, [{ kind: "transport_timeout" }]);
  assert.equal(rejection.kind, "confirm_not_executed");
  assert.equal(timeout.kind, "keep_unknown");
});

test("definitive rejection wins over a later authoritative absence result", () => {
  const result = decideRecovery("OUTCOME_UNKNOWN", reliable, [
    { kind: "definitive_rejection", reason: "validation failed" },
    { kind: "authoritative_no_match" },
  ]);
  assert.equal(result.kind, "confirm_not_executed");
});

test("expired idempotency with a weak lookup preserves uncertainty", () => {
  const caps: PartnerCapabilities = { idempotency: true, lookup: "eventual", idempotencyRetentionValid: false };
  const result = decideRecovery("OUTCOME_UNKNOWN", caps, [{ kind: "weak_no_match" }]);
  assert.equal(result.kind, "keep_unknown");
});

test("authoritative absence still allows retry when idempotency retention has expired", () => {
  const caps: PartnerCapabilities = { idempotency: true, lookup: "authoritative", idempotencyRetentionValid: false };
  const result = decideRecovery("OUTCOME_UNKNOWN", caps, [{ kind: "authoritative_no_match" }]);
  assert.equal(result.kind, "authorize_retry");
  if (result.kind === "authorize_retry") assert.equal(result.useSameIdempotencyKey, false);
});

test("a mislabeled no-match is not proof when lookup is only eventual", () => {
  const result = decideRecovery("OUTCOME_UNKNOWN", weak, [{ kind: "authoritative_no_match" }]);
  assert.equal(result.kind, "keep_unknown");
});

test("local commit loss is not treated as success", () => {
  const result = decideRecovery("OUTCOME_UNKNOWN", reliable, [{ kind: "local_commit_lost" }]);
  assert.equal(result.kind, "keep_unknown");
});
