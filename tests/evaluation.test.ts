import test from "node:test";
import assert from "node:assert/strict";
import { deriveMetrics } from "../src/evaluation/score.js";
import { scenarios } from "../src/evaluation/scenarios.js";
import { runEvaluation, type ScenarioResult } from "../src/evaluation/evaluate.js";
import { simulate } from "../src/runtime/recovery.js";

const summary = runEvaluation();

function row(id: string, policy: ScenarioResult["policy"]): ScenarioResult {
  const found = summary.results.find(result => result.id === id && result.policy === policy);
  assert.ok(found, `${policy} ${id}`);
  return found;
}

test("evaluation totals are reduced from scenario rows", () => {
  for (const policy of ["naive_retry", "dockside"] as const) {
    const rows = summary.results.filter(result => result.policy === policy);
    assert.equal(summary.totals[policy].duplicateSideEffects, rows.reduce((sum, result) => sum + result.duplicateSideEffects, 0));
    assert.equal(summary.totals[policy].falseSuccesses, rows.filter(result => result.falseSuccess).length);
    assert.equal(summary.totals[policy].unsafeRetries, rows.reduce((sum, result) => sum + result.unsafeRetryDispatches, 0));
    assert.equal(summary.totals[policy].correctlyResolved, rows.filter(result => result.correctlyResolved).length);
    assert.equal(summary.totals[policy].escalatedOrUnresolved, rows.filter(result => result.escalatedOrUnresolved).length);
  }
});

test("every scenario lands in one outcome bucket", () => {
  for (const result of summary.results) {
    assert.equal(result.correctlyResolved && result.escalatedOrUnresolved, false);
    assert.equal(result.correctlyResolved && result.unsafeRetry, false);
    const classified = result.correctlyResolved
      || result.escalatedOrUnresolved
      || result.unsafeRetry
      || result.falseSuccess
      || result.duplicateSideEffects > 0;
    assert.equal(classified, true);
  }
});

test("dockside does not duplicate, falsely succeed, or retry unsafely", () => {
  assert.equal(summary.totals.dockside.duplicateSideEffects, 0);
  assert.equal(summary.totals.dockside.falseSuccesses, 0);
  assert.equal(summary.totals.dockside.unsafeRetries, 0);
  assert.ok(summary.totals.naive_retry.duplicateSideEffects > 0);
  assert.ok(summary.totals.naive_retry.unsafeRetries > 0);
});

test("S01 crash before send has no initial effect and one later booking", () => {
  const dockside = row("S01", "dockside");
  assert.equal(dockside.initialGroundTruth.dispatchBoundaryCrossed, false);
  assert.equal(dockside.initialGroundTruth.partnerApplied, false);
  assert.equal(dockside.partnerSideEffects, 1);
  assert.equal(dockside.finalState, "CONFIRMED_SUCCEEDED");
  assert.equal(dockside.actionId, "action-S01");
  assert.deepEqual(dockside.attempts.map(attempt => attempt.phase), ["not_dispatched", "committed"]);
  assert.deepEqual(dockside.attempts.map(attempt => attempt.attemptId), ["action-S01-attempt-1", "action-S01-attempt-2"]);
  assert.ok(dockside.evidence.some(item => item.kind === "dispatch_boundary_not_crossed"));
  assert.equal(dockside.evidence.some(item => item.kind === "transport_timeout"), false);
  assert.equal(dockside.correctlyResolved, true);
});

test("S02 authoritative absence authorizes one retry", () => {
  const dockside = row("S02", "dockside");
  assert.equal(dockside.recoveryDecision, "authorize_retry");
  assert.equal(dockside.finalState, "CONFIRMED_SUCCEEDED");
  assert.equal(dockside.partnerSideEffects, 1);
  assert.ok(dockside.evidence.some(item => item.kind === "authoritative_no_match"));
  assert.equal(dockside.correctlyResolved, true);
});

test("S03 lost response confirms the existing booking without a duplicate", () => {
  const dockside = row("S03", "dockside");
  const naive = row("S03", "naive_retry");
  assert.equal(dockside.recoveryDecision, "confirm_success");
  assert.equal(dockside.partnerSideEffects, 1);
  assert.equal(dockside.laterDispatchBookingCount, 0);
  assert.ok(dockside.evidence.some(item => item.kind === "transport_timeout"));
  assert.ok(dockside.evidence.some(item => item.kind === "authoritative_match"));
  assert.ok(naive.partnerSideEffects > dockside.partnerSideEffects);
  assert.equal(dockside.duplicateSideEffects, 0);
  assert.ok(naive.duplicateSideEffects > 0);
});

test("S04 lost local commit is confirmed from lookup, not from the lost response", () => {
  const dockside = row("S04", "dockside");
  assert.equal(dockside.initialGroundTruth.responseReceived, true);
  assert.equal(dockside.initialGroundTruth.responseCommitted, false);
  assert.ok(dockside.evidence.some(item => item.kind === "local_commit_lost"));
  assert.ok(dockside.evidence.some(item => item.kind === "authoritative_match"));
  assert.equal(dockside.evidence.some(item => item.kind === "partner_success"), false);
  assert.equal(dockside.partnerSideEffects, 1);
  assert.equal(dockside.laterDispatchBookingCount, 0);
  assert.equal(dockside.recoveryDecision, "confirm_success");
});

test("S05 records a definitive no-effect rejection", () => {
  const dockside = row("S05", "dockside");
  const naive = row("S05", "naive_retry");
  assert.equal(dockside.recoveryDecision, "confirm_not_executed");
  assert.equal(dockside.finalState, "CONFIRMED_NOT_EXECUTED");
  assert.equal(dockside.partnerSideEffects, 0);
  assert.ok(dockside.evidence.some(item => item.kind === "definitive_rejection"));
  assert.equal(dockside.evidence.some(item => item.kind === "transport_timeout"), false);
  assert.equal(naive.recoveryDecision, "retry_after_timeout");
  assert.ok(naive.evidence.some(item => item.kind === "definitive_rejection"));
  assert.equal(naive.unsafeRetry, true);
  assert.equal(dockside.correctlyResolved, true);
});

test("S06 grants one dispatch authorization to two competing workers", () => {
  const dockside = row("S06", "dockside");
  const naive = row("S06", "naive_retry");
  assert.equal(dockside.dispatchAuthorizations, 1);
  assert.equal(dockside.workerOutcomes.filter(worker => worker.applied).length, 1);
  assert.equal(dockside.workerOutcomes.filter(worker => worker.dispatchAuthorized).length, 1);
  assert.equal(dockside.partnerSideEffects, 1);
  assert.equal(dockside.attempts.filter(attempt => attempt.phase !== "not_dispatched").length >= 1, true);
  assert.ok(new Set(dockside.attempts.map(attempt => attempt.attemptId)).size === dockside.attempts.length);
  assert.ok(naive.partnerSideEffects > dockside.partnerSideEffects);
  assert.ok(naive.dispatchAuthorizations > dockside.dispatchAuthorizations);
});

test("S07 weak no-match does not authorize a retry", () => {
  const dockside = row("S07", "dockside");
  assert.equal(dockside.initialGroundTruth.partnerApplied, true);
  assert.equal(dockside.recoveryDecision, "keep_unknown");
  assert.equal(dockside.finalState, "OUTCOME_UNKNOWN");
  assert.equal(dockside.laterDispatchBookingCount, 0);
  assert.ok(dockside.evidence.some(item => item.kind === "weak_no_match"));
  assert.equal(dockside.evidence.some(item => item.kind === "authoritative_no_match"), false);
  assert.equal(dockside.escalatedOrUnresolved, true);
  assert.equal(row("S07", "naive_retry").duplicateSideEffects > 0, true);
});

test("S08 ambiguous lookup escalates and creates no additional booking", () => {
  const dockside = row("S08", "dockside");
  assert.equal(dockside.recoveryDecision, "escalate");
  assert.equal(dockside.finalState, "ESCALATED");
  assert.equal(dockside.laterDispatchBookingCount, 0);
  assert.equal(dockside.duplicateSideEffects, 0);
  assert.equal(dockside.partnerSideEffects, 1);
  assert.equal(dockside.worldBookingCount, 2);
  assert.ok(dockside.evidence.some(item => item.kind === "lookup_ambiguous"));
});

test("S09 same-key replay is deduplicated by the partner simulator", () => {
  const dockside = row("S09", "dockside");
  const naive = row("S09", "naive_retry");
  assert.equal(dockside.recoveryDecision, "authorize_retry");
  assert.equal(dockside.recoveryDispatches[0]?.usedSameIdempotencyKey, true);
  assert.equal(dockside.recoveryDispatches[0]?.createdNewBooking, false);
  assert.equal(dockside.partnerSideEffects, 1);
  assert.equal(dockside.finalState, "CONFIRMED_SUCCEEDED");
  assert.deepEqual(dockside.attempts.map(attempt => attempt.attemptId), ["action-S09-attempt-1", "action-S09-attempt-2"]);
  assert.equal(dockside.actionId, "action-S09");
  assert.equal(naive.recoveryDispatches[0]?.usedSameIdempotencyKey, false);
  assert.equal(naive.partnerSideEffects, 2);
});

test("S10 with no idempotency and no lookup does not retry", () => {
  const dockside = row("S10", "dockside");
  const naive = row("S10", "naive_retry");
  assert.equal(dockside.recoveryDecision, "escalate");
  assert.equal(dockside.laterDispatchBookingCount, 0);
  assert.equal(dockside.escalatedOrUnresolved, true);
  assert.ok(naive.partnerSideEffects > dockside.partnerSideEffects);
});

test("a timeout confirmed as success is scored as a false success", () => {
  const scenario = scenarios.find(item => item.id === "S03");
  assert.ok(scenario);
  const trace = simulate(scenario, "dockside");
  const metrics = deriveMetrics({
    ...trace,
    evidence: [{ kind: "transport_timeout" }],
    recoveryDecision: "confirm_success",
    finalState: "CONFIRMED_SUCCEEDED",
  });
  assert.equal(metrics.falseSuccess, true);
  assert.equal(metrics.correctlyResolved, false);
});

test("dockside success decisions include positive evidence", () => {
  for (const result of summary.results.filter(item => item.policy === "dockside" && item.recoveryDecision === "confirm_success")) {
    assert.ok(result.evidence.some(item =>
      item.kind === "authoritative_match" || item.kind === "partner_success" || item.kind === "visible_match",
    ));
  }
});
