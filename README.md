# Volc Agent Launchpad

A minimal Agent platform for three-day middleware hackathons. It provides Agent
CRUD, a browser Playground, persistent workspaces, and Codex CLI backed by the
ModelArk Responses API.

This repository is the foundation for **Agent Airlock**, transactional execution middleware that runs every Agent task against isolated Candidate State and promotes only outcomes that satisfy a versioned Outcome Contract.
Read the [product requirements](docs/product/PRD.md), [outcome roadmap](docs/product/OUTCOME_ROADMAP.md), [architecture](docs/architecture/agent-airlock.md), [Phase 0-2 plan](.omx/plans/phases-0-2-execution.md), and [Phase 3-4 plan](.omx/plans/phases-3-4-execution.md) before extending Airlock.
Unresolved product and architecture decisions are coordinated through the [Agent Airlock Wayfinder map](https://github.com/Kk120306/agent-airlock/issues/1).

Run it locally with Docker, Colima, or rootless Podman, or deploy it to
Volcengine ECS.

> [!WARNING]
> This is a single-user proof of concept. It intentionally has no identity,
> tracing, audit, or hardened sandbox middleware. Do not use production data or
> credentials. See [SECURITY.md](SECURITY.md).

## Screenshots

### Agent Playground

![Agent Playground showing lifecycle controls, starter prompts, and the Codex Runtime](docs/assets/playground.jpg)

### Create an Agent

![Create Agent form with name, description, and workspace instructions](docs/assets/create-agent.jpg)

## Features

- React and TypeScript Web UI
- Agent create, edit, start, stop, delete, and multi-turn chat
- Fastify control plane with asynchronous Run state
- Transactional Agent workspaces and Codex sessions
- Immutable Whole-Agent Candidate and Canonical versions with Promotion or Quarantine
- Versioned Outcome Contracts with bounded, redacted Validation evidence
- Compact Airlock timeline, two-resource disposition, change summary, canonical fingerprint, and Promotion Receipt
- Disposable Docker, Colima, or Podman container for each local turn
- Docker and Terraform deployment paths for Volcengine ECS

## Requirements

- Node.js 22+
- npm 10+
- Docker, Colima, or Podman
- A ModelArk API key and endpoint or model that supports the Responses API

Codex CLI is included in the Runtime image and is not required on the host.

## Local browser SOP

### 1. Check the local tools

Install Node.js 22+ and one supported container engine, then verify them:

```bash
node --version
npm --version
docker --version        # Docker Desktop, Docker Engine, or Colima
podman --version        # Use this instead when running Podman
```

Only one container engine is required. Codex CLI is already included in the
Runtime image.

### 2. Clone the repository

```bash
git clone <repository-url> volc-agent-launchpad
cd volc-agent-launchpad
```

Skip this step when already working from the repository root.

### 3. Start the POC

```bash
cp .env.example .env
# Fill ARK_API_KEY, ARK_MODEL, and the region-matching ARK_BASE_URL.
npm run poc
```

The first run loads `.env`, installs Node.js dependencies, and builds the Runtime image.
Explicit process environment variables take precedence over `.env`.
The script automatically selects Docker, Colima, or Podman.

### 4. Open the browser

Visit <http://localhost:3000>, or open it from the terminal:

```bash
open http://localhost:3000       # macOS
xdg-open http://localhost:3000   # Linux desktop
```

In the Web UI:

1. Select **Create Agent**.
2. Enter a name, description, and workspace instructions.
3. Select **Create Agent** again.
4. Enter a task in the Playground, for example:

   ```text
   Create a TypeScript hello-world CLI, add a test, and run it.
   ```

The Agent can write files, run commands, and continue the same Codex session in
later messages.

### 5. Stop and resume

Press `Ctrl+C` in the startup terminal. The script removes temporary Runtime
containers but keeps Agent workspaces and conversations.

- macOS state: `~/.volc-agent-launchpad/`
- Linux state: `.local/`
- Custom location: set `LOCAL_POC_DATA_ROOT`

Run the same `npm run poc` command to continue later.

### Select a specific container engine

Force Podman when multiple engines are installed:

```bash
CONTAINER_ENGINE=podman \
ARK_API_KEY=your-ark-api-key \
ARK_MODEL=ep-your-endpoint-id \
npm run poc
```

Colima uses `CONTAINER_ENGINE=docker` because it exposes the Docker CLI.

For a clean Linux host, follow the
[rootless Podman setup](docs/LOCAL_POC.md#rootless-podman-on-linux).

## Docker Compose

Create and edit the configuration:

```bash
./scripts/bootstrap-local.sh
```

Required values in `.env`:

```dotenv
ARK_API_KEY=your-ark-api-key
ARK_MODEL=ep-your-endpoint-id
APP_AUTH_TOKEN=replace-with-at-least-24-random-characters
```

Start the application:

```bash
docker compose up --build
```

Open <http://localhost:3000>. Stop it without deleting Agent data:

```bash
docker compose down
```

## Development

```bash
npm install
cp .env.example .env
npm install --global @openai/codex@0.111.0
npm run dev
```

- Web UI: <http://localhost:5173>
- API: <http://localhost:3000>

Use local paths in `.env` when running outside Docker:

```dotenv
APP_DATA_DIR=.data
AGENT_WORKSPACE_ROOT=workspaces
CODEX_HOME=codex-home
```

## Deployment

- [Existing Linux ECS with Docker](docs/DEPLOYMENT.md#existing-linux-ecs)
- [Complete Volcengine environment with Terraform](docs/DEPLOYMENT.md#terraform-deployment)
- [Local Docker, Colima, and Podman details](docs/LOCAL_POC.md)

The existing-ECS script deploys from the current source tree:

```bash
cp .env.example .env.production
./scripts/deploy-existing-ecs.sh .env.production
```

The Terraform path provisions VPC, subnet, security group, ECS, and EIP:

```bash
cp deploy/volcengine/terraform.tfvars.example \
  deploy/volcengine/terraform.tfvars
./scripts/deploy-volcengine.sh
```

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `ARK_API_KEY` | Required | Ark model API key. |
| `ARK_MODEL` | Required | Responses-capable endpoint or model ID. |
| `ARK_BASE_URL` | Beijing v3 endpoint | Region-matching Ark API URL; BytePlus AP uses `https://ark.ap-southeast.bytepluses.com/api/v3`. |
| `APP_AUTH_TOKEN` | Empty on loopback | Shared demo token; use 24+ random characters remotely. |
| `RUNTIME_PROVIDER` | `local-process` | `container` for disposable local Runtime containers. |
| `CODEX_SANDBOX_MODE` | `workspace-write` | Codex inner sandbox mode. |
| `CODEX_TIMEOUT_MS` | `600000` | Maximum duration of one turn. |
| `LOCAL_POC_DATA_ROOT` | Platform-specific | Local metadata, workspace, and session directory. |

See [.env.example](.env.example) for all Runtime and resource-limit options.

## How it works

```mermaid
flowchart LR
    UI["React Web UI"] --> API["Fastify control plane"]
    API --> Airlock["Agent Airlock"]
    Airlock --> Store["Candidate and Canonical workspace plus session"]
    Airlock --> Runtime{"Runtime provider"}
    Runtime -->|Local POC| Container["Disposable Docker / Colima / Podman container"]
    Runtime -->|ECS profile| Codex["Codex CLI in application container"]
    Airlock --> Validate["Bounded Validations"]
    Validate --> Decision{"Promote or Quarantine"}
    Container --> Ark["ModelArk Responses API"]
    Codex --> Ark
```

The first turn uses `codex exec`; later turns resume the stored Codex thread.
Deleting an Agent archives its workspace under `workspaces/.deleted/`.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for component and extension
boundaries.

## Validation

```bash
npm run check
npm run test:e2e
npm run test:codex-session-container
npm run test:validation-container
terraform fmt -check -recursive deploy/volcengine
docker compose config
```

`npm run test:e2e` runs the production React and Fastify path in installed Google Chrome against a deterministic Codex protocol fixture.
Use `npm run check:phase0` to run the starter checks and this complete baseline journey together.
Use `npm run check:phase2` to run the full qualifying proof, browser journey, and dependency audit.
Use `npm run check:phase3` to add the pinned Codex session-isolation and real validation-container proofs.
Build `volc-agent-runtime:local` from `Dockerfile.runtime` before running either container proof.
The network-disabled Codex probe proves that a copied `CODEX_HOME` resumes the accepted thread without mutating its source and that an empty home cannot resume it.
The validation-container test proves a real validation container has a read-only root, no Ark key, and only a disposable validation copy as its writable project mount.
The credentialed ModelArk acceptance journey remains the browser SOP documented above.

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Agent Airlock architecture](docs/architecture/agent-airlock.md)
- [One-page judging architecture](docs/demo/architecture-one-page.md)
- [Three-minute live demo](docs/demo/three-minute-demo.md)
- [Product requirements](docs/product/PRD.md)
- [Outcome roadmap](docs/product/OUTCOME_ROADMAP.md)
- [Local POC](docs/LOCAL_POC.md)
- [Deployment](docs/DEPLOYMENT.md)
- [Hackathon extension guide](docs/HACKATHON_EXTENSION_GUIDE.md)
- [Security policy](SECURITY.md)
- [Contributing](CONTRIBUTING.md)

## License

[MIT](LICENSE)
