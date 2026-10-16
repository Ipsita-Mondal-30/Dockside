import {
  annotate,
  applyRecoveryDecision,
  beginInitialDispatch,
  beginRetryDispatch,
  createAction,
  sideEffectBoundaryWasCrossed,
  transition,
  type ActionEvidence,
  type ActionState,
  type AttemptPhase,
  type AttemptRecord,
  type LogicalAction,
  type PartnerCapabilities,
} from "../domain/action.js";
import { decideRecovery, type RecoveryDecision } from "../policy/recovery-policy.js";
import {
  PartnerSimulator,
  type AttemptGroundTruth,
  type AttemptObservation,
  type AttemptRequest,
} from "../simulator/partner.js";
import { PAYLOAD_HASH, SHIPMENT_REF, type Scenario } from "../evaluation/scenarios.js";

export type PolicyName = "naive_retry" | "dockside";

export type RecoveryDispatch = {
  workerId: string;
  /** Key actually sent on the wire for this recovery dispatch. */
  idempotencyKey: string;
  /** True when the recovery dispatch reused the logical action's stable key. */
  usedSameIdempotencyKey: boolean;
  consultedEvidence: ActionEvidence[];
  createdNewBooking: boolean;
};

export type WorkerOutcome = {
  workerId: string;
  applied: boolean;
  dispatchAuthorized: boolean;
  decision: RecoveryDecision["kind"];
};

export type SimulationTrace = {
  id: string;
  title: string;
  description: string;
  policy: PolicyName;
  capabilities: PartnerCapabilities;
  actionId: string;
  idempotencyKey: string;
  finalState: ActionState;
  recoveryDecision: string;
  recoveryReason: string;
  evidence: ActionEvidence[];
  attempts: AttemptRecord[];
  initialGroundTruth: AttemptGroundTruth;
  /** Bookings attributed to this action after the initial fault, before recovery. */
  initialPartnerSideEffects: number;
  /** Final bookings attributed to this logical action. Unrelated similar bookings are excluded. */
  partnerSideEffects: number;
  /** New bookings created by recovery dispatches (partner may report 0 when an idempotent key replays). */
  laterDispatchBookingCount: number;
  /** Count of recovery dispatches that crossed the partner boundary. */
  dispatchAttempts: number;
  worldBookingCount: number;
  dispatchAuthorizations: number;
  recoveryDispatches: RecoveryDispatch[];
  workerOutcomes: WorkerOutcome[];
};

type CommitResult = {
  applied: boolean;
  dispatchAuthorized: boolean;
};

export class RecoveryRace {
  private version = 0;
  private action: LogicalAction;
  readonly authorizations: string[] = [];

  constructor(action: LogicalAction) {
    this.action = action;
  }

  get current(): LogicalAction {
    return this.action;
  }

  snapshotVersion(): number {
    return this.version;
  }

  tryCommit(input: {
    expectedVersion: number;
    workerId: string;
    evidence: ActionEvidence[];
    decision: RecoveryDecision;
  }): CommitResult {
    if (input.expectedVersion !== this.version) return { applied: false, dispatchAuthorized: false };
    if (this.action.state !== "OUTCOME_UNKNOWN" && this.action.state !== "RECONCILING") {
      return { applied: false, dispatchAuthorized: false };
    }
    if (input.decision.kind === "authorize_retry" && this.authorizations.length > 0) {
      return { applied: false, dispatchAuthorized: false };
    }

    let next = this.action;
    for (const item of input.evidence) next = annotate(next, item);
    if (next.state === "OUTCOME_UNKNOWN") next = transition(next, "RECONCILING");
    next = applyRecoveryDecision(next, input.decision);

    this.action = next;
    this.version += 1;
    if (input.decision.kind === "authorize_retry") this.authorizations.push(input.workerId);
    if (this.authorizations.length > 1) {
      throw new Error(`Duplicate dispatch authorization for ${this.action.actionId}`);
    }
    return { applied: true, dispatchAuthorized: input.decision.kind === "authorize_retry" };
  }

  completeDispatch(workerId: string, action: LogicalAction): void {
    if (this.authorizations.length !== 1 || this.authorizations[0] !== workerId) {
      throw new Error("Dispatch completion requires the single authorized worker");
    }
    this.action = action;
    this.version += 1;
  }
}

export function simulate(scenario: Scenario, policy: PolicyName): SimulationTrace {
  const partner = new PartnerSimulator(scenario.capabilities);
  for (let index = 0; index < scenario.unrelatedSimilarBookings; index += 1) {
    partner.book({
      shipmentRef: SHIPMENT_REF,
      payloadHash: PAYLOAD_HASH,
      idempotencyKey: `unrelated-${scenario.id}-${index}`,
      causedByActionId: `unrelated-${scenario.id}-${index}`,
    });
  }

  const actionId = `action-${scenario.id}`;
  let action = createAction(actionId, SHIPMENT_REF, PAYLOAD_HASH);
  const initial = runInitialAttempt(action, partner, scenario);
  action = initial.action;

  if (policy === "naive_retry") return finishNaive(scenario, partner, action, initial.groundTruth);
  return finishDockside(scenario, partner, action, initial.groundTruth);
}

function runInitialAttempt(
  action: LogicalAction,
  partner: PartnerSimulator,
  scenario: Scenario,
): { action: LogicalAction; groundTruth: AttemptGroundTruth } {
  const request = requestFor(action, action.idempotencyKey, scenario.eventualIndexVisible);
  if (scenario.fault === "before_dispatch") {
    const execution = partner.executeAttempt(request, "before_dispatch");
    return { action: recordPreDispatch(action, execution.observation), groundTruth: execution.groundTruth };
  }

  const dispatching = beginInitialDispatch(action);
  const execution = partner.executeAttempt(
    requestFor(dispatching, dispatching.idempotencyKey, scenario.eventualIndexVisible),
    scenario.fault,
  );
  return { action: persistObservation(dispatching, execution.observation), groundTruth: execution.groundTruth };
}

function finishDockside(
  scenario: Scenario,
  partner: PartnerSimulator,
  action: LogicalAction,
  initialGroundTruth: AttemptGroundTruth,
): SimulationTrace {
  const recoveryDispatches: RecoveryDispatch[] = [];

  if (canDispatchAfterClearBoundary(action)) {
    const consultedEvidence = [...action.evidence];
    const started = beginInitialDispatch(action);
    const execution = partner.executeAttempt(requestFor(started, started.idempotencyKey, true), "none");
    const completed = persistObservation(started, execution.observation);
    recoveryDispatches.push({
      workerId: "w1",
      idempotencyKey: started.idempotencyKey,
      usedSameIdempotencyKey: true,
      consultedEvidence,
      createdNewBooking: execution.groundTruth.createdNewBooking,
    });
    return toTrace({
      scenario,
      policy: "dockside",
      action: completed,
      initialGroundTruth,
      partner,
      recoveryDecision: "authorize_retry",
      recoveryReason: "Local journal proves the earlier attempt did not cross the side-effect boundary",
      dispatchAuthorizations: 1,
      recoveryDispatches,
      workerOutcomes: [{
        workerId: "w1",
        applied: true,
        dispatchAuthorized: true,
        decision: "authorize_retry",
      }],
    });
  }

  if (action.state !== "OUTCOME_UNKNOWN" && action.state !== "RECONCILING") {
    throw new Error(`Dockside recovery reached an unexpected state ${action.state}`);
  }

  const lookedUp = lookupEvidence(partner, action);
  const evidenceForPolicy = lookedUp ? [...action.evidence, lookedUp] : [...action.evidence];
  const decision = decideRecovery(action.state, scenario.capabilities, evidenceForPolicy);
  const race = new RecoveryRace(action);
  const snapshotVersion = race.snapshotVersion();
  const workerOutcomes: WorkerOutcome[] = [];
  let winner: string | null = null;

  for (let index = 0; index < scenario.workers; index += 1) {
    const workerId = `w${index + 1}`;
    const committed = race.tryCommit({
      expectedVersion: snapshotVersion,
      workerId,
      evidence: lookedUp ? [lookedUp] : [],
      decision,
    });
    workerOutcomes.push({
      workerId,
      applied: committed.applied,
      dispatchAuthorized: committed.dispatchAuthorized,
      decision: decision.kind,
    });
    if (committed.dispatchAuthorized) winner = workerId;
  }

  if (race.authorizations.length > 1) {
    throw new Error(`Duplicate dispatch authorization for ${action.actionId}`);
  }

  if (winner && decision.kind === "authorize_retry") {
    const started = beginRetryDispatch(race.current);
    // Dockside always reuses the logical action's stable key. Retention validity
    // decides whether that key can be trusted for deduplication, not which key is sent.
    const idempotencyKey = started.idempotencyKey;
    const execution = partner.executeAttempt(requestFor(started, idempotencyKey, true), "none");
    race.completeDispatch(winner, persistObservation(started, execution.observation));
    recoveryDispatches.push({
      workerId: winner,
      idempotencyKey,
      usedSameIdempotencyKey: true,
      consultedEvidence: evidenceForPolicy,
      createdNewBooking: execution.groundTruth.createdNewBooking,
    });
  }

  return toTrace({
    scenario,
    policy: "dockside",
    action: race.current,
    initialGroundTruth,
    partner,
    recoveryDecision: decision.kind,
    recoveryReason: decision.reason,
    dispatchAuthorizations: race.authorizations.length,
    recoveryDispatches,
    workerOutcomes,
  });
}

function finishNaive(
  scenario: Scenario,
  partner: PartnerSimulator,
  action: LogicalAction,
  initialGroundTruth: AttemptGroundTruth,
): SimulationTrace {
  const recoveryDispatches: RecoveryDispatch[] = [];
  const workerOutcomes: WorkerOutcome[] = [];
  for (let index = 0; index < scenario.workers; index += 1) {
    const workerId = `w${index + 1}`;
    // The baseline never reads the journal, lookup, rejection, or idempotency window.
    const idempotencyKey = `naive-${action.actionId}-${workerId}`;
    const execution = partner.executeAttempt({
      actionId: action.actionId,
      shipmentRef: action.shipmentRef,
      payloadHash: action.payloadHash,
      idempotencyKey,
    }, "none");
    recoveryDispatches.push({
      workerId,
      idempotencyKey,
      usedSameIdempotencyKey: false,
      consultedEvidence: [],
      createdNewBooking: execution.groundTruth.createdNewBooking,
    });
    workerOutcomes.push({
      workerId,
      applied: true,
      dispatchAuthorized: true,
      decision: "authorize_retry",
    });
  }

  return toTrace({
    scenario,
    policy: "naive_retry",
    action,
    initialGroundTruth,
    partner,
    recoveryDecision: "retry_after_timeout",
    recoveryReason: "Blind retry sends a fresh request and ignores partner capabilities",
    dispatchAuthorizations: scenario.workers,
    recoveryDispatches,
    workerOutcomes,
  });
}

function canDispatchAfterClearBoundary(action: LogicalAction): boolean {
  return action.state === "READY"
    && action.attempts.length > 0
    && !sideEffectBoundaryWasCrossed(action)
    && action.evidence.some(item => item.kind === "dispatch_boundary_not_crossed");
}

function recordPreDispatch(action: LogicalAction, observation: AttemptObservation): LogicalAction {
  if (action.state !== "READY") throw new Error("Pre-dispatch crash must start from READY");
  if (!observation.evidence.some(item => item.kind === "dispatch_boundary_not_crossed")) {
    throw new Error("before_dispatch fault did not produce boundary evidence");
  }
  const attemptCount = action.attemptCount + 1;
  const attemptId = `${action.actionId}-attempt-${attemptCount}`;
  return {
    ...action,
    attemptId,
    attemptCount,
    evidence: [...action.evidence, ...observation.evidence],
    attempts: [...action.attempts, { attemptId, phase: "not_dispatched", evidence: [...observation.evidence] }],
  };
}

function persistObservation(action: LogicalAction, observation: AttemptObservation): LogicalAction {
  let next = action;
  for (const evidence of observation.evidence) next = annotate(next, evidence, phaseFor(evidence));
  if (observation.evidence.some(item => item.kind === "partner_success")) return transition(next, "CONFIRMED_SUCCEEDED");
  return transition(next, "OUTCOME_UNKNOWN");
}

function phaseFor(evidence: ActionEvidence): AttemptPhase {
  return evidence.kind === "partner_success" ? "committed" : "outcome_unknown";
}

function lookupEvidence(partner: PartnerSimulator, action: LogicalAction): ActionEvidence | null {
  const result = partner.lookup(action.shipmentRef, action.payloadHash);
  switch (result.kind) {
    case "unavailable":
      return null;
    case "match":
      return partner.capabilities.lookup === "authoritative"
        ? { kind: "authoritative_match", bookingId: result.booking.bookingId }
        : { kind: "visible_match", bookingId: result.booking.bookingId };
    case "no_match":
      return partner.capabilities.lookup === "authoritative"
        ? { kind: "authoritative_no_match" }
        : { kind: "weak_no_match" };
    case "weak_no_match":
      return { kind: "weak_no_match" };
    case "ambiguous":
      return { kind: "lookup_ambiguous", candidateIds: result.bookingIds };
  }
}

function requestFor(action: LogicalAction, idempotencyKey: string, visibleToEventualLookup: boolean): AttemptRequest {
  return {
    actionId: action.actionId,
    shipmentRef: action.shipmentRef,
    payloadHash: action.payloadHash,
    idempotencyKey,
    visibleToEventualLookup,
  };
}

function toTrace(input: {
  scenario: Scenario;
  policy: PolicyName;
  action: LogicalAction;
  initialGroundTruth: AttemptGroundTruth;
  partner: PartnerSimulator;
  recoveryDecision: string;
  recoveryReason: string;
  dispatchAuthorizations: number;
  recoveryDispatches: RecoveryDispatch[];
  workerOutcomes: WorkerOutcome[];
}): SimulationTrace {
  const laterDispatchBookingCount = input.recoveryDispatches.filter(dispatch => dispatch.createdNewBooking).length;
  const partnerSideEffects = input.partner.bookings.filter(
    booking => booking.causedByActionId === input.action.actionId,
  ).length;
  const initialPartnerSideEffects = input.initialGroundTruth.createdNewBooking
    || input.initialGroundTruth.partnerApplied
    ? 1
    : 0;
  return {
    id: input.scenario.id,
    title: input.scenario.title,
    description: input.scenario.description,
    policy: input.policy,
    capabilities: input.scenario.capabilities,
    actionId: input.action.actionId,
    idempotencyKey: input.action.idempotencyKey,
    finalState: input.action.state,
    recoveryDecision: input.recoveryDecision,
    recoveryReason: input.recoveryReason,
    evidence: input.action.evidence,
    attempts: input.action.attempts,
    initialGroundTruth: input.initialGroundTruth,
    initialPartnerSideEffects,
    partnerSideEffects,
    laterDispatchBookingCount,
    dispatchAttempts: input.recoveryDispatches.length,
    worldBookingCount: input.partner.bookings.length,
    dispatchAuthorizations: input.dispatchAuthorizations,
    recoveryDispatches: input.recoveryDispatches,
    workerOutcomes: input.workerOutcomes,
  };
}
