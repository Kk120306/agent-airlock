import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AgentDeletionJournal,
  type AgentArchiveAudit,
} from "./agent-deletion-journal.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("Agent deletion journal", () => {
  it("keeps the largest bounded prepared summary readable and rejects overflow", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "airlock-agent-deletion-journal-"),
    );
    temporaryDirectories.push(directory);
    const journal = new AgentDeletionJournal(directory);
    await journal.initialize();
    const audit: AgentArchiveAudit = {
      schemaVersion: 2,
      agentId: "agent-one",
      archivedAt: "2026-08-26T00:00:00.000Z",
      runs: Array.from({ length: 100 }, (_, index) => ({
        runId:
          "run-" + String(index).padStart(4, "0") + "-" + "x".repeat(110),
        status: "completed",
        candidateSetId: null,
        disposition: "promoted",
        promotionReceiptDigest: null,
      })),
      candidateSets: [],
      assuranceProposals: [],
      outcomeContractVersions: [],
      aggregate: {
        runCount: 10_000,
        candidateSetCount: 0,
        assuranceProposalCount: 0,
        outcomeContractVersionCount: 0,
        evidenceDigest: "sha256:" + "a".repeat(64),
      },
    };

    await expect(journal.begin(audit.agentId, audit)).resolves.toMatchObject({
      phase: "prepared",
      audit: { schemaVersion: 2, aggregate: { runCount: 10_000 } },
    });
    await expect(journal.read(audit.agentId)).resolves.toMatchObject({
      audit: { runs: expect.any(Array) },
    });
    expect((await stat(path.join(directory, "agent-one.json"))).size).toBeLessThan(
      200_000,
    );

    const overflow: AgentArchiveAudit = {
      ...audit,
      agentId: "agent-two",
      runs: [
        ...audit.runs,
        {
          runId: "run-overflow",
          status: "completed",
          candidateSetId: null,
          disposition: "promoted",
          promotionReceiptDigest: null,
        },
      ],
    };
    await expect(journal.begin(overflow.agentId, overflow)).rejects.toThrow(
      "exceeds its bounds",
    );
    expect(await readdir(directory)).toEqual(["agent-one.json"]);
  });

  it("rejects a schema 1 journal audit downgrade", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "airlock-agent-deletion-downgrade-"),
    );
    temporaryDirectories.push(directory);
    const journal = new AgentDeletionJournal(directory);
    await journal.initialize();
    const legacyAudit: AgentArchiveAudit = {
      schemaVersion: 1,
      agentId: "agent-one",
      archivedAt: "2026-08-26T00:00:00.000Z",
      runs: [],
      candidateSets: [],
    };

    await expect(journal.begin(legacyAudit.agentId, legacyAudit)).rejects.toThrow(
      "requires archive audit schema 2",
    );
    expect(await readdir(directory)).toEqual([]);
  });

  it.each([
    [
      "accepted Proposal without its decision evidence",
      {
        assuranceProposals: [
          {
            proposalId: "a".repeat(64),
            state: "accepted",
            baseContractVersion: 1,
            proposalDigest: "sha256:" + "b".repeat(64),
            decisionAction: "accepted",
            decisionDigest: null,
            resultingContractVersion: null,
          },
        ],
        outcomeContractVersions: [],
      },
    ],
    [
      "rejected Proposal with a resulting contract version",
      {
        assuranceProposals: [
          {
            proposalId: "a".repeat(64),
            state: "rejected",
            baseContractVersion: 1,
            proposalDigest: "sha256:" + "b".repeat(64),
            decisionAction: "rejected",
            decisionDigest: "sha256:" + "c".repeat(64),
            resultingContractVersion: 2,
          },
        ],
        outcomeContractVersions: [],
      },
    ],
    [
      "Assurance-authored contract without its Proposal authority",
      {
        assuranceProposals: [],
        outcomeContractVersions: [
          {
            version: 2,
            contractHash: "sha256:" + "d".repeat(64),
            provenance: "assurance-proposal",
            sourceProposalId: null,
            rollbackFromVersion: null,
          },
        ],
      },
    ],
    [
      "rollback contract without its prior version",
      {
        assuranceProposals: [],
        outcomeContractVersions: [
          {
            version: 3,
            contractHash: "sha256:" + "d".repeat(64),
            provenance: "rollback",
            sourceProposalId: null,
            rollbackFromVersion: null,
          },
        ],
      },
    ],
  ])("rejects contradictory %s", async (_label, evidence) => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "airlock-agent-deletion-contradiction-"),
    );
    temporaryDirectories.push(directory);
    const journal = new AgentDeletionJournal(directory);
    await journal.initialize();
    const audit = {
      schemaVersion: 2,
      agentId: "agent-one",
      archivedAt: "2026-08-26T00:00:00.000Z",
      runs: [],
      candidateSets: [],
      assuranceProposals: evidence.assuranceProposals,
      outcomeContractVersions: evidence.outcomeContractVersions,
      aggregate: {
        runCount: 0,
        candidateSetCount: 0,
        assuranceProposalCount: evidence.assuranceProposals.length,
        outcomeContractVersionCount: evidence.outcomeContractVersions.length,
        evidenceDigest: "sha256:" + "e".repeat(64),
      },
    } as AgentArchiveAudit;

    await expect(journal.begin(audit.agentId, audit)).rejects.toThrow(
      /Assurance Proposal|Outcome Contract version/,
    );
    expect(await readdir(directory)).toEqual([]);
  });
});
