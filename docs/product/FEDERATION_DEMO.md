# Federation Airlock demo

## Fastest proof

Run:

```bash
npm run test:phase12:real
```

This command builds the production application, starts two independently configured Fastify instances, and drives the complete transfer through a real Chrome browser.
The producer completes a local Promotion and downloads a self-verifying Federated Work Bundle.
The receiver installs its own organizational trust policy and accepts the downloaded bundle through the visible Federation Airlock.
The automated proof pauses at an approval-required Admission, verifies Canonical State is unchanged, records a local operator approval, materializes isolated Candidate State, reruns the receiver Outcome Contract, and performs receiver-owned Promotion.
No ModelArk request, wallet, RPC call, blockchain transaction, or paid inference is used.
The same command runs in the hosted `Release proof` workflow on every pull request, so the repository cannot merge a UI or HTTP change that silently breaks the federation journey.

Run the same proof in a visible browser for a presentation:

```bash
npm run demo:phase12
```

## Adversarial operator proof

Run:

```bash
npm run test:phase11:ui:mock
```

The production UI suite proves visible local approval and denial in addition to untrusted authority, compromised signer, wrong Agent scope, stale receipt, protocol downgrade, and transparency split-view rejections with Canonical State shown as unchanged.
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
The resulting panel shows the durable Admission identity, policy generation, operator decision digest, receiver Run, required Validation count, and whether Canonical State advanced.
