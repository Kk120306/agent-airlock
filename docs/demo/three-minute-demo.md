# Agent Airlock three-minute demo

## Demo promise

The demo proves that a disposable Agent container is not enough when persistent state is mounted into it, and that Airlock prevents an unacceptable future from becoming canonical.

## Prepared fixture

Use one starter-kit Agent with a TypeScript application containing:

- A passing unit test suite.
- A required `src/index.ts` file.
- A protected `package.json` file.
- A SQLite database containing one canonical inventory record.
- A mock notification outbox consumer.

Configure an Outcome Contract that requires the tests to pass, preserves the required and protected paths, limits changed files, scans changed content for secrets, and validates typed notification intents.

## Timeline

### 0:00 to 0:25 - Establish the risk

Show the existing Playground and explain that the Runtime container is disposable while its mounted workspace is persistent.
Show the current Canonical State identifier and green Outcome Contract.

### 0:25 to 1:05 - Promote a valid future

Ask the Agent to add a health-check command, update the tests, update the SQLite fixture, and prepare a notification.
Show the Run Transaction moving through preparation, execution, validation, and promotion.
Show the file summary, database change, passing validations, one delivered notification, and the new Canonical State identifier.

### 1:05 to 1:55 - Quarantine a destructive future

Ask the Agent to simplify the project by deleting the tests and replacing the application with a static file.
Show that the Agent performs the work inside Candidate State.
Show the Outcome Contract rejecting the missing required path and failed test command.
Show that the Run is quarantined, the canonical content hash is unchanged, the canonical SQLite query is unchanged, and no notification was delivered.

### 1:55 to 2:35 - Repair without contamination

Start a Repair Run from the Quarantine.
Airlock supplies the failed Validation evidence and asks the Agent to restore the required behavior.
Show the repaired Candidate State passing and becoming canonical.

### 2:35 to 3:00 - Close with control and evidence

Open the Promotion Receipt and point to the Run ancestry, validations, bounded changes, and resulting state version.
Send a short follow-up prompt to prove that the Agent continues from the promoted Codex session and workspace.

## Required proof points

- A real Codex Run modifies Candidate State.
- A successful Run promotes files, session state, SQLite state, and one mock external intent.
- A failed Run leaves all canonical resources unchanged.
- A Repair Run continues from Quarantine rather than from corrupted Canonical State.
- The ordinary Agent lifecycle and Playground remain usable afterward.

## Controlled fallback

If live model latency threatens the three-minute window, prepare the fixture and first successful Run before judging, then execute the rejection and repair journey live.
Do not replace middleware behavior with recorded or hard-coded success states.

