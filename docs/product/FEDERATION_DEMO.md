# Federation Airlock demo

## Fastest proof

Run:

```bash
npm run test:phase12:real
```

This command builds the production application, starts two independently configured Fastify instances, and drives the complete transfer through a real Chrome browser.
The producer completes a local Promotion and downloads a self-verifying Federated Work Bundle.
The receiver installs its own organizational trust policy and accepts the downloaded bundle through the visible Federation Airlock.
The automated proof pauses at an approval-required Admission, verifies Canonical State is unchanged, reloads the receiver browser, rediscovers the same item in the durable inbox, inspects the receiver metadata preflight, records a local operator approval, materializes isolated Candidate State, reruns the receiver Outcome Contract, and performs receiver-owned Promotion.
No ModelArk request, wallet, RPC call, blockchain transaction, or paid inference is used.
The same command runs in the hosted `Release proof` workflow on every pull request, so the repository cannot merge a UI or HTTP change that silently breaks the federation journey.

Run the complete release proof, including the real pinned Codex Runtime container, with:

```bash
npm run check:phase13
```

This command auto-selects a running Docker engine, Colima Docker context, or Podman engine, builds the Runtime image, and drives both the two-instance federation browser and browser-to-container Promotion journeys.

Run the same proof in a visible browser for a presentation:

```bash
npm run demo:phase12
```

## Adversarial operator proof

Run:

```bash
npm run test:phase11:ui:mock
```

The production UI suite proves reload-safe local approval, visible denial, and a fail-closed stale-operator conflict in addition to untrusted authority, compromised signer, wrong Agent scope, stale receipt, protocol downgrade, and transparency split-view rejections with Canonical State shown as unchanged.
It also proves that artifact tamper, receipt tamper, and conflicting replay errors remain fail-closed before the interface can claim Promotion.
The lower protocol, policy, admission journal, and HTTP suites independently verify the underlying cryptography, exact replay identity, immutable decision evidence, local Quarantine, and crash recovery behavior.

## What to point out

The producer's signature proves bundle integrity and key possession, but it does not grant authority on the receiver.
The receiver selects the trusted producer and pinned policy generation before import.
The four visible stages are cryptographic verification, Candidate isolation, receiver Validation, and receiver Promotion or Quarantine.
The import path never invokes a model Runtime.
An exact retry reuses one immutable Admission Record, one immutable local decision, and at most one Candidate Run.
A rejected authority or failed required Validation leaves receiver Canonical State unchanged.

## Browser controls

After any completed local Promotion, generate a Portable Trust receipt and choose **Download federated work**.
On the receiving Agent, choose **Federation**, select the trusted producer, upload the Federated Work Bundle and signed organizational trust policy, and choose **Admit into Candidate State**.
When the policy requires approval, record a reason and choose **Approve into Candidate State** or **Deny and preserve Canonical**.
You may reload or reopen the receiver before deciding, select the pending transfer in **Durable approval inbox**, and continue through the same append-only decision path.
Before deciding, point out **Evidence-first review**, the exact proposed operation paths and sizes, and the explicit **Producer claim - not receiver authority** boundary.
Then point out **Receiver metadata preflight**, its receiver Outcome Contract version, any predicted metadata blockers, and the named checks deferred to authoritative Candidate Validation.
For the strongest negative proof, the production browser suite proposes a change to protected `AGENTS.md` and shows the blocker before any Run exists or Canonical State changes.
No staged file content or signing material is sent to the browser, and the receiver still performs its own checks only after approval.
The resulting panel shows the durable Admission identity, policy generation, operator decision digest, receiver Run, required Validation count, and whether Canonical State advanced.
