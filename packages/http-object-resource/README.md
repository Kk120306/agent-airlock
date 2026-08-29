# HTTP Object Transactional Resource

This package is a credential-free reference Resource Provider that stores immutable JSON object versions behind a bounded HTTP boundary.
It depends only on the Agent Airlock Transactional Resource SDK and Node.js platform APIs.

The Agent Runtime receives only a Candidate-local `object.json` binding.
Canonical authority remains the Agent Airlock manifest reference, while the remote service stores immutable content-addressed versions and run-keyed idempotency records.

The provider declares that native remote mutable-pointer atomicity and distributed atomic commit are unsupported.
Promotion is safe because immutable version installation is idempotent and restart reconciliation verifies the exact planned fingerprint before Agent Airlock advances or accepts Canonical metadata.

## Verify the provider

From the repository root, run:

```bash
npm run check:phase8:conformance
```

The exported conformance fixture uses the real provider implementation with a deterministic in-memory HTTP transport.
The provider test suite separately starts a child HTTP server when local socket binding is permitted and exercises timeout, response-size, content-type, malformed-response, unavailability, source-mismatch, and tamper failures.

## Register an immutable source

The application composition root accepts these non-secret variables together:

```dotenv
AIRLOCK_HTTP_OBJECT_URL=http://127.0.0.1:4500
AIRLOCK_HTTP_OBJECT_VERSION_ID=version-source
AIRLOCK_HTTP_OBJECT_FINGERPRINT=<64-lowercase-hex-characters>
```

`AIRLOCK_HTTP_OBJECT_SOCKET` may name a local Unix socket while the URL continues to define the HTTP request origin.
Incomplete configuration is rejected at startup.
The provider requires no credential and makes no paid request.

Run the complete production extension demo with:

```bash
npm run demo:phase8 -- --reset
```

The launcher starts the reference provider as a separate local process, passes its immutable source reference to Agent Airlock, and tears down both processes on exit.
