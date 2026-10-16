import type { ActionEvidence, ActionState, PartnerCapabilities } from "../domain/action.js";

export type RecoveryDecision =
  | { kind: "confirm_success"; reason: string }
  | { kind: "confirm_not_executed"; reason: string }
  | { kind: "authorize_retry"; reason: string; useSameIdempotencyKey: boolean }
  | { kind: "escalate"; reason: string }
  | { kind: "keep_unknown"; reason: string };

const RECOVERABLE_STATES = new Set<ActionState>(["OUTCOME_UNKNOWN", "RECONCILING"]);

export function hasUsableIdempotency(capabilities: PartnerCapabilities): boolean {
  return capabilities.idempotency === true && capabilities.idempotencyRetentionValid === true;
}

export function evidenceProvesSuccess(evidence: readonly ActionEvidence[]): boolean {
  return evidence.some(item =>
    item.kind === "authoritative_match" || item.kind === "partner_success" || item.kind === "visible_match",
  );
}

/**
 * Decide how to recover an ambiguous action from policy-visible evidence only.
 * Caller-supplied capabilities and evidence are the whole input; partner ground
 * truth never belongs in this function.
 */
export function decideRecovery(
  state: ActionState,
  capabilities: PartnerCapabilities,
  evidence: readonly ActionEvidence[],
): RecoveryDecision {
  if (!RECOVERABLE_STATES.has(state)) {
    return { kind: "escalate", reason: `Recovery policy cannot resolve state ${state}` };
  }

  const kinds = new Set(evidence.map(item => item.kind));

  if (kinds.has("lookup_ambiguous")) {
    return { kind: "escalate", reason: "Multiple possible partner records; automated matching is unsafe" };
  }

  if (evidenceProvesSuccess(evidence)) {
    return { kind: "confirm_success", reason: "Recorded evidence identifies an existing booking" };
  }

  if (kinds.has("definitive_rejection")) {
    return { kind: "confirm_not_executed", reason: "Partner contract states this rejection caused no effect" };
  }

  if (kinds.has("authoritative_no_match") && capabilities.lookup === "authoritative") {
    return {
      kind: "authorize_retry",
      reason: "Authoritative lookup establishes no matching effect",
      useSameIdempotencyKey: hasUsableIdempotency(capabilities),
    };
  }

  if (hasUsableIdempotency(capabilities)) {
    return {
      kind: "authorize_retry",
      reason: "Partner-enforced idempotency is inside its retention window",
      useSameIdempotencyKey: true,
    };
  }

  // A weak or eventually consistent lookup can miss a booking that already exists.
  // Absence is not proof, including when an idempotency key is past retention.
  if (kinds.has("weak_no_match") || capabilities.lookup === "eventual") {
    return { kind: "keep_unknown", reason: "Eventually consistent lookup cannot prove non-execution" };
  }

  if (capabilities.lookup === "none") {
    const reason = capabilities.idempotency
      ? "Idempotency is outside its retention window and no lookup can prove the outcome"
      : "No idempotency or lookup capability; outcome cannot be established safely";
    return { kind: "escalate", reason };
  }

  return { kind: "keep_unknown", reason: "Available evidence does not establish a safe resolution or retry" };
}
