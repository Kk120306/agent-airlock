# Security policy

Volc Agent Launchpad is a hackathon proof of concept.
Only the latest revision on the default branch is supported.

## Report a vulnerability

Send the repository owner or event organizer the affected revision, reproduction steps, impact, and suggested mitigation.
Do not publish credentials, personal data, or exploit details in an issue.

## Known limitations

- Shared demo token; no user identity, authorization, RBAC, or tenant isolation
- No CSRF protection
- No per-Agent container boundary in ECS mode
- Ordinary local containers, not hardened multi-tenant sandboxes
- Broad outbound network access
- Supported action intents can be bypassed through direct outbound Runtime traffic
- The local-process Repair Runtime receives a disposable Canonical workspace copy that is integrity-checked but not protected by an operating-system read-only mount
- Prompt-triggered command and file execution
- Ark key available to the server and active Runtime container
- Ark key stored in Terraform POC state
- Local host access can tamper with the Promotion journal, immutable versions, canonical manifest, or mock-delivery store
- A remote Resource Provider can be unavailable, malicious, or inconsistent despite passing the bounded conformance fixture
- Provider installation and local canonical-manifest advancement are recoverable but are not one distributed atomic commit
- The local-process Runtime cannot enforce a provider-declared read-only filesystem binding and rejects that provider configuration

## Safe use

- Prefer `npm run demo -- --reset` for judging rehearsal while organizer credentials are pending.
- The deterministic demo binds only to loopback, uses an unreachable loopback Ark URL, and makes no paid inference request.
- Startup rejects demo mode unless every no-cost fixture marker matches the launcher's loopback profile.
- Treat the deterministic Codex protocol fixture as untrusted Runtime behavior even though its outputs are reproducible.
- Do not enable `AIRLOCK_DEMO_MODE` manually for a credentialed POC or interpret fixture output as model-quality evidence.
- Use a dedicated development machine or disposable ECS instance.
- Use a scoped, revocable Ark key and a unique `APP_AUTH_TOKEN`.
- Keep local use on loopback and restrict ECS Web and SSH CIDRs.
- Add HTTPS before sending the shared token over an untrusted network.
- Never mount production data or provide Volcengine account AK/SK to Agents.
- Treat `.airlock/demo.sqlite` and the notification outbox as bounded demonstration resources only.
- Treat quarantined work and Repair Run prompts as untrusted Agent-controlled content.
- Keep `APP_DATA_DIR` and `AGENT_WORKSPACE_ROOT` writable only by the trusted local control-plane account.
- Treat `recovery-error` as a physical-state contradiction and preserve the data directory before diagnosis.
- Use the container Runtime when an operating-system read-only mount for the disposable repair reference is required.
- Do not interpret mock-consumer idempotency as an exactly-once guarantee for third-party providers.
- Register only immutable provider source references whose fingerprints were established through a trusted control-plane path.
- Require provider onboarding to reconcile the exact configured immutable version before any Agent canonical manifest changes.
- Keep Resource Provider evolution additive until an explicit export-and-retire migration exists for removal or contract replacement.
- Keep future provider credentials in the trusted control plane and never place them in provider metadata, Candidate bindings, Runtime environment variables, logs, or browser evidence.
- Reject provider-controlled identifiers, Runtime-relative paths, summaries, metadata, lifecycle evidence, reconciliation evidence, and raw errors when credential detection or bounded redaction cannot make them safe, including keyed forms such as password or token assignments.
- Treat a provider Capability Claim as admissible only after the executable conformance suite and integration fault matrix pass for that exact provider version.
- Reject redirects, oversized source objects, non-regular files, and post-Runtime symbolic-link substitutions before a trusted provider hook reads Candidate content.
- Preserve provider state and the Promotion journal when provider reconciliation reports a contradiction.
- Treat every Registry Transition journal as untrusted recovery input and require its exact schema, deterministic identifiers, additive provider vectors, and exact verification set before it can authorize cleanup.
- Stop the POC, destroy test resources, and revoke keys after the event.

Codex uses `workspace-write` when Landlock is available.
On unsupported kernels, startup warns and relies on the outer Docker or rootless Podman boundary.
This fallback is not tenant isolation.
