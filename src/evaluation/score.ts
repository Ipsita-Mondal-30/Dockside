import { evidenceProvesSuccess, hasUsableIdempotency } from "../policy/recovery-policy.js";
import type { RecoveryDispatch, SimulationTrace } from "../runtime/recovery.js";

export type DerivedMetrics = {
  /** New bookings for this action created by recovery after an effect already existed. */
  duplicateSideEffects: number;
  falseSuccess: boolean;
  unsafeRetry: boolean;
  unsafeRetryDispatches: number;
  correctlyResolved: boolean;
  /** Escalate with no unsafe retry and no duplicate. */
  correctlyEscalated: boolean;
  /** keep_unknown / unresolved with no unsafe retry and no duplicate. */
  unresolved: boolean;
  /** Back-compat aggregate used by older report consumers. */
  escalatedOrUnresolved: boolean;
};

/**
 * Duplicate side effects are counted against the logical action under test.
 * Unrelated similar bookings that already existed in the world are excluded
 * because `partnerSideEffects` only attributes bookings via `causedByActionId`.
 *
 * Relative to the initial state:
 * - If the action already had a partner effect, every recovery-created booking is a duplicate.
 * - If it did not, the first recovery-created booking is allowed; further ones are duplicates.
 */
export function countDuplicateSideEffects(trace: SimulationTrace): number {
  if (trace.initialPartnerSideEffects > 0) return trace.laterDispatchBookingCount;
  return Math.max(0, trace.laterDispatchBookingCount - 1);
}

export function deriveMetrics(trace: SimulationTrace): DerivedMetrics {
  const unsafeDispatches = trace.recoveryDispatches.filter(dispatch =>
    dispatchIsUnsafe(dispatch, trace),
  );
  const duplicateSideEffects = countDuplicateSideEffects(trace);
  const falseSuccess = claimsSuccess(trace)
    && (!evidenceProvesSuccess(trace.evidence) || trace.partnerSideEffects === 0);
  const unsafeRetry = unsafeDispatches.length > 0;
  const incorrect = unsafeRetry || falseSuccess || duplicateSideEffects > 0;
  const correctlyResolved = !incorrect && isFaithfulTerminal(trace);
  const correctlyEscalated = !incorrect
    && !correctlyResolved
    && trace.recoveryDecision === "escalate"
    && trace.finalState === "ESCALATED";
  const unresolved = !incorrect
    && !correctlyResolved
    && !correctlyEscalated
    && (trace.recoveryDecision === "keep_unknown"
      || trace.finalState === "OUTCOME_UNKNOWN"
      || trace.finalState === "RECONCILING");

  return {
    duplicateSideEffects,
    falseSuccess,
    unsafeRetry,
    unsafeRetryDispatches: unsafeDispatches.length,
    correctlyResolved,
    correctlyEscalated,
    unresolved,
    escalatedOrUnresolved: correctlyEscalated || unresolved,
  };
}

function dispatchIsUnsafe(dispatch: RecoveryDispatch, trace: SimulationTrace): boolean {
  const kinds = new Set(dispatch.consultedEvidence.map(item => item.kind));
  if (kinds.has("lookup_ambiguous") || kinds.has("weak_no_match") || kinds.has("definitive_rejection")) {
    return true;
  }
  // Same-key retry is safe only while partner retention is declared valid.
  if (dispatch.usedSameIdempotencyKey && hasUsableIdempotency(trace.capabilities)) return false;
  if (kinds.has("authoritative_no_match") && trace.capabilities.lookup === "authoritative") return false;
  if (kinds.has("dispatch_boundary_not_crossed")) return false;
  return true;
}

function claimsSuccess(trace: SimulationTrace): boolean {
  return trace.finalState === "CONFIRMED_SUCCEEDED" || trace.recoveryDecision === "confirm_success";
}

function isFaithfulTerminal(trace: SimulationTrace): boolean {
  if (trace.finalState === "CONFIRMED_SUCCEEDED") {
    return trace.partnerSideEffects === 1 && evidenceProvesSuccess(trace.evidence);
  }
  if (trace.finalState === "CONFIRMED_NOT_EXECUTED") {
    return trace.partnerSideEffects === 0
      && trace.initialGroundTruth.partnerApplied === false
      && trace.recoveryDecision === "confirm_not_executed";
  }
  return false;
}
