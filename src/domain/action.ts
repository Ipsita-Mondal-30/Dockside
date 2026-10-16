export type ActionState =
  | "PROPOSED"
  | "READY"
  | "DISPATCHING"
  | "OUTCOME_UNKNOWN"
  | "RECONCILING"
  | "RETRY_AUTHORIZED"
  | "CONFIRMED_SUCCEEDED"
  | "CONFIRMED_NOT_EXECUTED"
  | "ESCALATED"
  | "CANCELLED_BEFORE_DISPATCH";

export type PartnerCapabilities = {
  idempotency: boolean;
  lookup: "authoritative" | "eventual" | "none";
  /** True only while a partner-enforced idempotency key is still inside its retention window. */
  idempotencyRetentionValid?: boolean;
};

export type ActionEvidence =
  | { kind: "partner_success"; bookingId: string }
  | { kind: "authoritative_match"; bookingId: string }
  | { kind: "visible_match"; bookingId: string }
  | { kind: "authoritative_no_match" }
  | { kind: "weak_no_match" }
  | { kind: "definitive_rejection"; reason: string }
  | { kind: "lookup_ambiguous"; candidateIds: string[] }
  | { kind: "transport_timeout" }
  | { kind: "local_commit_lost" }
  | { kind: "dispatch_boundary_not_crossed" }
  | { kind: "operator_resolution"; outcome: "succeeded" | "not_executed"; rationale: string };

export type AttemptPhase = "not_dispatched" | "dispatch_boundary_crossed" | "outcome_unknown" | "committed";

export type AttemptRecord = {
  attemptId: string;
  phase: AttemptPhase;
  evidence: ActionEvidence[];
};

export type RetryAuthorization = {
  attemptId: string;
  useSameIdempotencyKey: boolean;
};

export type LogicalAction = {
  actionId: string;
  attemptId: string;
  shipmentRef: string;
  payloadHash: string;
  state: ActionState;
  attemptCount: number;
  evidence: ActionEvidence[];
  attempts: AttemptRecord[];
  idempotencyKey: string;
  retryAuthorization: RetryAuthorization | null;
};

const ALLOWED: Record<ActionState, readonly ActionState[]> = {
  PROPOSED: ["READY", "CANCELLED_BEFORE_DISPATCH"],
  READY: ["DISPATCHING", "CANCELLED_BEFORE_DISPATCH"],
  DISPATCHING: ["OUTCOME_UNKNOWN", "CONFIRMED_SUCCEEDED"],
  OUTCOME_UNKNOWN: ["RECONCILING", "RETRY_AUTHORIZED", "CONFIRMED_SUCCEEDED", "CONFIRMED_NOT_EXECUTED", "ESCALATED"],
  RECONCILING: ["OUTCOME_UNKNOWN", "RETRY_AUTHORIZED", "CONFIRMED_SUCCEEDED", "CONFIRMED_NOT_EXECUTED", "ESCALATED"],
  RETRY_AUTHORIZED: ["DISPATCHING"],
  CONFIRMED_SUCCEEDED: [],
  CONFIRMED_NOT_EXECUTED: [],
  ESCALATED: [],
  CANCELLED_BEFORE_DISPATCH: ["READY"],
};

export function createAction(actionId: string, shipmentRef: string, payloadHash: string): LogicalAction {
  return {
    actionId,
    attemptId: `${actionId}-unstarted`,
    shipmentRef,
    payloadHash,
    state: "READY",
    attemptCount: 0,
    evidence: [],
    attempts: [],
    idempotencyKey: `idem-${actionId}`,
    retryAuthorization: null,
  };
}

export function transition(action: LogicalAction, state: ActionState, evidence?: ActionEvidence): LogicalAction {
  if (!ALLOWED[action.state].includes(state)) {
    throw new Error(`Illegal transition ${action.state} -> ${state}`);
  }
  const nextEvidence = evidence ? [...action.evidence, evidence] : [...action.evidence];
  const attempts = action.attempts.map(attempt => {
    if (!evidence || attempt.attemptId !== action.attemptId) return attempt;
    return { ...attempt, evidence: [...attempt.evidence, evidence] };
  });
  return { ...action, state, evidence: nextEvidence, attempts };
}

export function annotate(action: LogicalAction, evidence: ActionEvidence, phase?: AttemptPhase): LogicalAction {
  return {
    ...action,
    evidence: [...action.evidence, evidence],
    attempts: action.attempts.map(attempt => {
      if (attempt.attemptId !== action.attemptId) return attempt;
      return {
        ...attempt,
        phase: phase ?? attempt.phase,
        evidence: [...attempt.evidence, evidence],
      };
    }),
  };
}

export function sideEffectBoundaryWasCrossed(action: LogicalAction): boolean {
  return action.attempts.some(attempt => attempt.phase !== "not_dispatched");
}

export function beginInitialDispatch(action: LogicalAction): LogicalAction {
  if (action.state !== "READY" && action.state !== "CANCELLED_BEFORE_DISPATCH") {
    throw new Error(`Initial dispatch is not allowed from state ${action.state}`);
  }
  if (sideEffectBoundaryWasCrossed(action)) {
    throw new Error("Side-effect boundary was already crossed; retry requires explicit authorization");
  }
  if (action.attempts.length > 0 && !action.evidence.some(item => item.kind === "dispatch_boundary_not_crossed")) {
    throw new Error("A prior attempt exists without proof that it stopped before the side-effect boundary");
  }

  const ready = action.state === "CANCELLED_BEFORE_DISPATCH" ? transition(action, "READY") : action;
  const dispatching = transition(ready, "DISPATCHING");
  const attemptCount = action.attemptCount + 1;
  const attemptId = `${action.actionId}-attempt-${attemptCount}`;
  return {
    ...dispatching,
    attemptId,
    attemptCount,
    attempts: [...dispatching.attempts, { attemptId, phase: "dispatch_boundary_crossed", evidence: [] }],
  };
}

export function beginRetryDispatch(action: LogicalAction): LogicalAction {
  if (action.state !== "RETRY_AUTHORIZED" || action.retryAuthorization === null) {
    throw new Error("Retry dispatch requires explicit authorization");
  }
  const dispatching = transition(action, "DISPATCHING");
  const attemptCount = action.attemptCount + 1;
  const attemptId = `${action.actionId}-attempt-${attemptCount}`;
  return {
    ...dispatching,
    attemptId,
    attemptCount,
    retryAuthorization: null,
    attempts: [...dispatching.attempts, { attemptId, phase: "dispatch_boundary_crossed", evidence: [] }],
  };
}

export function applyRecoveryDecision(
  action: LogicalAction,
  decision: {
    kind: "confirm_success" | "confirm_not_executed" | "authorize_retry" | "escalate" | "keep_unknown";
    useSameIdempotencyKey?: boolean;
  },
): LogicalAction {
  if (action.state !== "OUTCOME_UNKNOWN" && action.state !== "RECONCILING") {
    throw new Error(`Refusing to apply recovery decision ${decision.kind} to state ${action.state}`);
  }

  switch (decision.kind) {
    case "confirm_success":
      return transition(action, "CONFIRMED_SUCCEEDED");
    case "confirm_not_executed":
      return transition(action, "CONFIRMED_NOT_EXECUTED");
    case "authorize_retry":
      return {
        ...transition(action, "RETRY_AUTHORIZED"),
        retryAuthorization: {
          attemptId: action.attemptId,
          useSameIdempotencyKey: decision.useSameIdempotencyKey === true,
        },
      };
    case "escalate":
      return transition(action, "ESCALATED");
    case "keep_unknown":
      return action.state === "OUTCOME_UNKNOWN" ? action : transition(action, "OUTCOME_UNKNOWN");
  }
}
