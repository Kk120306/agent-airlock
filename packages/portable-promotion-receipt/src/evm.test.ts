import { describe, expect, it } from "vitest";
import { encodeOfflineEvmAnchorPayload, keccak256 } from "./evm.js";

describe("offline EVM anchor payload", () => {
  it("matches the Keccak-256 empty-input vector", () => {
    expect(keccak256(new Uint8Array()).toString("hex")).toBe(
      "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470",
    );
  });

  it("encodes only the receipt digest without network or funds", () => {
    const digest = `sha256:${"ab".repeat(32)}` as const;
    const payload = encodeOfflineEvmAnchorPayload(digest);
    expect(payload.calldata).toBe(
      `${payload.functionSelector}${"ab".repeat(32)}`,
    );
    expect(payload.networkCalls).toBe(0);
    expect(payload.fundsSpent).toBe(0);
    expect(JSON.stringify(payload)).not.toMatch(/rpc|wallet|private|prompt|output/i);
  });
});
