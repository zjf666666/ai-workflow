# Deterministic Engineering Workflow

A script-owned engineering workflow for teams that use AI without allowing an AI agent to control deterministic delivery processes.

The central idea is simple: **AI is a tool inside a workflow, not the workflow owner.** A deterministic runtime owns scheduling, state transitions, retries, gates, evidence, and escalation. Pi is invoked only for bounded tasks such as research, design generation, or semantic review.

> **Current integration:** this repository supports **Pi only** as its AI executor. The workflow contract is intentionally independent of any one model, but adapters for other coding agents have not been implemented.

## Why this exists

Agent-led workflows are convenient, but they make the control plane probabilistic. An agent can misunderstand a prompt, skip a required check, retry forever, or decide that an incomplete result is “good enough.” Those are unacceptable failure modes for engineering processes with explicit delivery rules.

This project separates responsibilities:

```text
Agent-first workflow
AI decides what to do next → calls tools → judges completion → chooses whether to retry

Deterministic Engineering Workflow
Workflow YAML + runtime → schedules a node → invokes Pi → evaluates an independent gate
                                  │                         │
                                  └──── owns state ─────────┘
```

The runtime, rather than the AI, decides whether work passes, requires rework, blocks, fails, or needs human intervention.

## Core principles

- **The runtime owns the control plane.** Workflow definitions specify node order, enabled state, inputs, outputs, retries, gates, and failure routing.
- **Pi is a bounded capability.** Pi can research, write, or review within a node. It cannot advance the workflow or authorize a downstream action.
- **Gates are independent.** Deterministic validation runs outside prompts and outside the model. A model’s self-check is advisory; a gate is authoritative.
- **Artifacts are the handoff contract.** Requirements, knowledge context, designs, gate results, review verdicts, and session metadata are versioned and auditable.
- **Failures are explicit and finite.** Configuration errors fail before execution. Missing inputs block nodes. Rework has a fixed limit, after which the workflow escalates to a human.
- **Humans retain decision ownership.** Product scope, behavior, compatibility, and accepted risk are resolved with the requirement owner, not silently invented by the model.

## Architecture

```text
                         ┌───────────────────────────────┐
                         │ Workflow YAML                  │
                         │ nodes, contracts, gates, limits │
                         └──────────────┬────────────────┘
                                        │
                                        ▼
┌──────────────────────────────────────────────────────────────────────┐
│ Deterministic Runtime                                                  │
│ preflight · scheduling · state machine · artifact store · audit log   │
└───────┬──────────────────────────────────────────────────────┬───────┘
        │                                                      │
        ▼                                                      ▼
┌───────────────────────┐                           ┌──────────────────┐
│ Bounded Pi executor    │                           │ Independent Gate │
│ research, generation,  │ ── versioned artifact ──> │ contract checks, │
│ semantic review        │                           │ pass/fail proof  │
└───────────────────────┘                           └────────┬─────────┘
                                                               │
                                     ┌─────────────────────────┼─────────────────────────┐
                                     ▼                         ▼                         ▼
                                   Pass                    Rework              Human intervention
                                next node            designated producer       terminal escalation
```

## Example workflow

A feature-design workflow can be modeled as:

```text
start observability
  → resolve knowledge
  → generate design with Pi
  → deterministic design gate
  → fresh-session AI design review
  → continue only when both checks pass
```

The deterministic gate validates requirements that can be objectively checked, for example:

- mandatory document sections and ordering;
- substantive section content rather than placeholders;
- verified repository or knowledge-base references;
- explicit alternatives and trade-offs;
- recorded owner decisions and constraints;
- concrete validation commands or test plans.

A separate Pi review handles semantic judgments that are not deterministic, such as whether a cited symbol supports a claim or whether the draft dodges a user-owned decision. Its verdict is still only an input to the runtime; the runtime performs the actual state transition.

## Current support

Pi is the only implemented AI executor. The runtime launches the local Pi CLI in a constrained, read-only mode and disables Pi extensions, context files, and Pi-managed Skills. This keeps workflow orchestration in the runtime and makes Pi an isolated node executor.

The repository currently provides `feature` and `bugfix` design workflows. Coding, testing, code-review, and merge-request nodes are deliberately declared but disabled until their deterministic contracts and gates are implemented.

## Repository layout

```text
.
├── workflow.yaml       # change-type selector
├── workflows/          # feature and bugfix node sequences
├── nodes/              # node, artifact, gate, retry, and review definitions
├── runtime/            # Node.js control plane and observability adapter
│   └── src/cli.ts      # preflight, state machine, artifact store, Pi adapter
└── run.ps1             # PowerShell entry point
```

## Usage

### Prerequisites

- Windows PowerShell 5.1 or later.
- Node.js with npm.
- [Pi](https://github.com/badlogic/pi-mono) installed and available through the local `pi.ps1` launcher.
- At least one Pi model configured locally. The launcher can list available models interactively, or a model can be passed explicitly.
- A target Git repository that contains the knowledge files required by the current knowledge-resolution node:
  - `knowledge/bussiness_catalog.md`
  - optionally, `knowledge/project/overview.md`

Install the runtime dependency once after cloning this repository:

```powershell
Push-Location .\runtime
npm.cmd ci
Pop-Location
```

### Inspect a workflow plan

Run `plan` before starting work. It performs static preflight validation and prints every node as `ENABLED`, `DISABLED`, or `CONFIGURATION_ERROR`.

```powershell
.\run.ps1 `
  -Command plan `
  -Project D:\path\to\target-repository `
  -Kind feature
```

### Start a feature workflow

```powershell
.\run.ps1 `
  -Command start `
  -Project D:\path\to\target-repository `
  -Kind feature `
  -Model provider/model-name `
  -RequirementText 'Describe the requested change, constraints, and acceptance criteria.'
```

`-Model` is optional. When it is omitted, `run.ps1` lists configured Pi models and prompts for a selection. `-Kind` is also optional for `start`; the launcher prompts for `feature` or `bugfix` when it is not supplied.

To load the requirement from a file instead of an inline argument, replace `-RequirementText` with `-Requirement`:

```powershell
.\run.ps1 `
  -Command start `
  -Project D:\path\to\target-repository `
  -Kind bugfix `
  -Requirement D:\path\to\requirement.md
```

### Complete the Pi design session

For design-generation nodes, the runtime opens a separate Pi window. Pi can inspect the target repository with read-only tools and may ask the requirement owner to decide scope, behavior, or trade-offs. Answer those questions in the same session.

When the design is complete, enter `/quit` in the Pi window. The runtime then extracts the final artifact and runs the deterministic gate followed by the independent Pi review.

### Resume rework

When a gate or review returns `REWORK_REQUIRED`, resume the same run directory. The workflow restores the existing Pi session and injects the recorded failure evidence into the rework request.

```powershell
.\run.ps1 `
  -Command resume `
  -Resume .\runtime\runs\<run-id>
```

The workflow stops automated rework after the configured maximum number of attempts and moves to `HUMAN_INTERVENTION_REQUIRED`.

### Run artifacts

Every execution is stored under `runtime/runs/<run-id>/`. Important outputs include:

- `run.yaml`: request and workflow metadata;
- `workflow.sqlite`: versioned artifacts, node state, and events;
- `run-events.log` and `run-status.txt`: operational evidence;
- `knowledge-context.json`: resolved repository context;
- `designed.md` or `bugfix-designed.md`: the generated design artifact;
- `kcc-draft.md`: a staged change-context draft;
- Pi event logs and resumable session files.

## Workflow states

| State | Meaning |
| --- | --- |
| `ENABLED` | The node is enabled and has passed static preflight validation. |
| `DISABLED` | The node is intentionally excluded from this run. |
| `CONFIGURATION_ERROR` | An enabled node lacks a valid definition, type, or gate configuration. Execution does not start. |
| `BLOCKED` | A required runtime condition, such as an input artifact, is missing. |
| `FAILED` / `TIMED_OUT` | A node failed or exceeded its execution limit. |
| `REWORK_REQUIRED` | A gate or review rejected the current artifact and routed execution back to its producer. |
| `HUMAN_INTERVENTION_REQUIRED` | Rework attempts were exhausted; automated looping stops. |
| `SUCCEEDED` | Every enabled node completed and passed its required checks. |

## Design decisions

### Explicit enablement

Future nodes—coding, unit tests, integration tests, code review, merge request creation—remain explicitly disabled until their implementation, artifact contract, execution adapter, gate, and failure policy are complete. A missing node must be a configuration error, never an implicit skip.

### Semantic references over line references

Artifact references should prefer semantic anchors such as `path/to/file.ext#SymbolName` over bare line numbers. The runtime verifies that the file and symbol exist. This survives unrelated edits and fails visibly when the referenced symbol is renamed or removed, rather than silently drifting to an incorrect line.

### Fresh sessions for independent review

The producer may retain its session during rework so that it does not lose context. Reviewers run in a fresh session so they have no stake in defending the original draft.

### Auditability by default

Each run should persist its workflow snapshot, node states, events, artifact versions and hashes, gate evidence, review verdicts, and resumable AI session metadata. The result is explainable after the fact instead of being buried in an agent transcript.

## Adding a node

Do not enable a new workflow step solely because an agent prompt exists. Before enabling it, define all of the following:

1. The node’s input and output artifact contract.
2. Its deterministic executor or bounded AI adapter.
3. Its independent validation gate, where validation is applicable.
4. Retry and rework limits.
5. Failure routing and the terminal escalation behavior.
6. Event and artifact records required for audit and resume.

Only then should the node change from `enabled: false` to `enabled: true`.

## Non-goals

- Replacing engineers or requirement owners with an autonomous agent.
- Treating prompts or Pi output as a source of workflow authority.
- Allowing an agent to silently skip validation or invent acceptance criteria.
- Using unlimited self-correction loops as a substitute for escalation.

## Guiding rule

> Let AI handle uncertain cognitive work. Let scripts own deterministic process control.
