# Dockside — Milestone 1 Executable Scaffold

This is the first executable slice of Dockside: a side-effect recovery harness for AI agents. It deliberately starts with a deterministic domain model and simulator, before adding PostgreSQL, Redis, queues, or an LLM.

## What is implemented

- A typed action state model and conservative recovery policy.
- A typed action state model, guarded transitions, and a conservative recovery policy.
- A partner simulator with explicit fault points, idempotency retention, and lookup profiles.
- Ten deterministic scenarios. Policy-visible evidence is separate from scorer ground truth.
- A naive retry baseline and a capability-aware policy for comparison.
- Unit tests for the recovery invariants.
- `npm run evaluate` writes `evaluations/REPORT.md` from the simulated traces.

## What is not implemented yet

- Durable PostgreSQL ledger or real process-crash recovery.
- Real partner integrations.
- Production concurrency guarantees.
- Real LLM agent behavior.
- Any claim of universal exactly-once execution.

The in-memory simulator is an executable model for reasoning and tests, not production-ready infrastructure.

## Requirements

- Node.js 20+
- npm

## Run

```bash
npm install
npm test
npm run typecheck
npm run evaluate
```

## Expected behavior

- The naive retry baseline creates duplicate effects in the "partner accepted, response lost" scenario.
- The capability-aware policy finds the existing booking when authoritative lookup is available and does not create a second effect.
- When neither a valid idempotency window nor lookup exists, an ambiguous action is escalated rather than retried.
- An expired idempotency window is not treated as protection against duplicates.
- A weak lookup miss and an ambiguous lookup do not authorize a retry.

## Design rule

A timeout is not proof that an external action failed. Dockside records uncertainty and only retries when an explicit policy and partner capability make the retry safe.

## Next implementation gate

After these tests pass, add PostgreSQL persistence and transactional dispatch claims. Do not add a real partner integration until the durable state transitions and concurrency tests exist.
