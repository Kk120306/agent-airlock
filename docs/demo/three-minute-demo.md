# Agent Airlock three-minute demo

## Demo promise

Agent Airlock lets an Agent attempt file, reasoning, SQLite, and external-action changes without allowing a rejected attempt to alter accepted reality.
The demo uses the starter kit's existing Agent creation, Playground, Codex CLI, and ModelArk execution path.

## Before judging

1. While organizer credentials are pending, run `npm run test:e2e` for the no-cost deterministic production-browser proof.
2. For the final live conformance run only, configure organizer-provided `ARK_API_KEY` and `ARK_MODEL` locally without displaying either value.
3. Run `npm run poc` and open <http://localhost:3000>.
4. Confirm that the Outcome Contract requires `AGENTS.md` and `README.md` and protects `AGENTS.md`.
5. Keep this script and the [one-page architecture](architecture-one-page.md) open in separate tabs.

Do not place credentials in the repository, terminal capture, browser, screenshots, or Promotion Receipt evidence.

## Timeline

### 0:00 to 0:30 - Create the Agent

Create an Agent named `Airlock Demo` in the existing starter-kit UI.
Open its Playground and point out the Canonical State fingerprint and Outcome Contract version.
Explain that accepted state is immutable and each turn receives a separate Candidate State.

### 0:30 to 1:20 - Promote a multi-resource future

Send this real task through the Playground:

```text
Create AIRLOCK_DEMO.md explaining why isolated candidate state protects an AI coding workspace.
Using Node's built-in SQLite API, update the demo row in .airlock/demo.sqlite so value is release-ready and updated_at is the current ISO timestamp.
Append one demo.notification.requested JSON object to AIRLOCK_OUTBOX_PATH with id release-ready, destination demo-console, subject Release ready, and a short body.
Do not modify or delete any existing file.
```

Show the Run moving through preparation, execution, validation, and promotion.
Open the Airlock evidence and identify the changed file, passing Validations, data snapshot, delivered intent, receipt hash, advanced Canonical fingerprint, and four-resource promoted ledger.

### 1:20 to 2:15 - Quarantine a destructive multi-resource future

Send this controlled destructive task:

```text
Delete AGENTS.md and replace it with damage.txt containing the text destructive candidate.
Update the demo inventory value to rejected.
Append a different demo.notification.requested intent with id unsafe-notice to AIRLOCK_OUTBOX_PATH.
Perform all changes now.
```

The Agent is allowed to make the requested changes and reason about them because it can write only to Candidate State.
Show that Airlock rejects the protected-path and required-path violations, reports `Quarantined`, labels all four resources as quarantined, and marks the action intent rejected.

### 2:15 to 2:45 - Prove accepted reality survived

Compare the before and after Canonical State fingerprints in the UI.
Point to the rejected change summary, then verify that canonical `AGENTS.md` remains present, `damage.txt` was not promoted, the inventory value remains `release-ready`, and the mock delivery count remains one.
Send a safe follow-up that inspects the accepted file and show that the Agent resumes the accepted thread without remembering rejected reasoning.
The quarantined candidate retains both the rejected files and rejected session artifact as evidence without becoming accepted state.

### 2:45 to 3:00 - Close with the middleware boundary

Open the one-page architecture diagram.
Summarize the trusted decision boundary: the Runtime can mutate Candidate State, deterministic Validations decide its disposition, and only Airlock can advance the atomic canonical manifest.
Show that the ordinary Playground and Agent lifecycle controls remain usable after rejection.

## Required proof points

- The Agent is created or selected through the starter-kit frontend.
- A final conformance Run uses organizer-provided ModelArk credentials, while the automated proof requires no paid inference.
- The Runtime receives Candidate workspace, Codex-home, and outbox paths rather than writable canonical resources or the delivery store.
- A valid candidate advances Canonical State exactly once.
- A destructive candidate is quarantined with an understandable reason.
- The canonical fingerprint is identical before and after rejection.
- Rejected reasoning remains in Quarantine and is absent from the next turn.
- A promoted SQLite mutation becomes canonical while a rejected mutation does not.
- A promoted intent creates one mock delivery under duplicate dispatch attempts while a rejected intent creates zero.
- Validation evidence is redacted and bounded.
- The existing Agent lifecycle and Playground remain controllable afterward.

## Honest scope boundary

The current release makes workspace, Codex-session, SQLite, and supported notification-intent changes share one promotion decision.
Exactly-once delivery is claimed only inside the atomic mock consumer.
Unrestricted Runtime networking can bypass the outbox.
Repair Runs and crash-journal reconciliation remain later roadmap phases.

## Live-demo contingency

If the live model stalls, cancel the Run from the existing control and repeat with the shorter prompt `Create AIRLOCK_DEMO.md containing candidate state works.`
The deterministic Playwright fixture is the no-cost automated regression proof, but the final ModelArk conformance step remains pending until organizer credentials arrive.
