import { Buffer } from "node:buffer";
import type { OfflineEvmAnchorPayload, ReceiptDigest } from "./types.js";
import { isDigest } from "./validation.js";

const METHOD_SIGNATURE = "anchor(bytes32)";

export function encodeOfflineEvmAnchorPayload(
  receiptDigest: ReceiptDigest,
): OfflineEvmAnchorPayload {
  if (!isDigest(receiptDigest)) {
    throw new Error("EVM anchor requires one canonical receipt digest");
  }
  const methodSelector = computeMethodSelector();
  const digestBytes = Buffer.from(receiptDigest.slice("sha256:".length), "hex");
  return {
    schema: "agent-airlock/offline-evm-anchor-payload",
    schemaVersion: 1,
    methodSignature: METHOD_SIGNATURE,
    functionSelector: `0x${methodSelector}`,
    receiptDigest,
    calldata: `0x${methodSelector}${digestBytes.toString("hex")}`,
    privacyClaim: "receipt-digest-only",
    networkCalls: 0,
    fundsSpent: 0,
  };
}

export function evmAnchorFunctionSelector(): string {
  return `0x${computeMethodSelector()}`;
}

export function keccak256(value: Uint8Array): Buffer {
  const rateBytes = 136;
  const paddedLength = Math.ceil((value.length + 1) / rateBytes) * rateBytes;
  const padded = Buffer.alloc(paddedLength);
  Buffer.from(value).copy(padded);
  padded[value.length] = 0x01;
  padded[padded.length - 1] = padded[padded.length - 1]! ^ 0x80;
  const state = Array<bigint>(25).fill(0n);
  for (let offset = 0; offset < padded.length; offset += rateBytes) {
    for (let lane = 0; lane < rateBytes / 8; lane += 1) {
      state[lane] = state[lane]! ^ readLane(padded, offset + lane * 8);
    }
    keccakF1600(state);
  }
  const output = Buffer.alloc(32);
  for (let lane = 0; lane < 4; lane += 1) {
    writeLane(output, lane * 8, state[lane]!);
  }
  return output;
}

const MASK_64 = (1n << 64n) - 1n;
const ROTATION = [
  0, 1, 62, 28, 27,
  36, 44, 6, 55, 20,
  3, 10, 43, 25, 39,
  41, 45, 15, 21, 8,
  18, 2, 61, 56, 14,
] as const;
const ROUND_CONSTANTS = [
  0x0000000000000001n,
  0x0000000000008082n,
  0x800000000000808an,
  0x8000000080008000n,
  0x000000000000808bn,
  0x0000000080000001n,
  0x8000000080008081n,
  0x8000000000008009n,
  0x000000000000008an,
  0x0000000000000088n,
  0x0000000080008009n,
  0x000000008000000an,
  0x000000008000808bn,
  0x800000000000008bn,
  0x8000000000008089n,
  0x8000000000008003n,
  0x8000000000008002n,
  0x8000000000000080n,
  0x000000000000800an,
  0x800000008000000an,
  0x8000000080008081n,
  0x8000000000008080n,
  0x0000000080000001n,
  0x8000000080008008n,
] as const;

function keccakF1600(state: bigint[]): void {
  for (const roundConstant of ROUND_CONSTANTS) {
    const columns = Array<bigint>(5).fill(0n);
    for (let x = 0; x < 5; x += 1) {
      columns[x] =
        state[x]! ^
        state[x + 5]! ^
        state[x + 10]! ^
        state[x + 15]! ^
        state[x + 20]!;
    }
    for (let x = 0; x < 5; x += 1) {
      const delta =
        columns[(x + 4) % 5]! ^ rotateLeft(columns[(x + 1) % 5]!, 1);
      for (let y = 0; y < 5; y += 1) {
        state[x + 5 * y] = (state[x + 5 * y]! ^ delta) & MASK_64;
      }
    }

    const moved = Array<bigint>(25).fill(0n);
    for (let x = 0; x < 5; x += 1) {
      for (let y = 0; y < 5; y += 1) {
        const destinationX = y;
        const destinationY = (2 * x + 3 * y) % 5;
        moved[destinationX + 5 * destinationY] = rotateLeft(
          state[x + 5 * y]!,
          ROTATION[x + 5 * y]!,
        );
      }
    }

    for (let y = 0; y < 5; y += 1) {
      for (let x = 0; x < 5; x += 1) {
        state[x + 5 * y] =
          (moved[x + 5 * y]! ^
            ((~moved[((x + 1) % 5) + 5 * y]!) &
              moved[((x + 2) % 5) + 5 * y]!)) &
          MASK_64;
      }
    }
    state[0] = state[0]! ^ roundConstant;
  }
}

function rotateLeft(value: bigint, amount: number): bigint {
  if (amount === 0) return value & MASK_64;
  const shift = BigInt(amount);
  return ((value << shift) | (value >> (64n - shift))) & MASK_64;
}

function readLane(buffer: Buffer, offset: number): bigint {
  let value = 0n;
  for (let byte = 0; byte < 8; byte += 1) {
    value |= BigInt(buffer[offset + byte]!) << BigInt(byte * 8);
  }
  return value;
}

function writeLane(buffer: Buffer, offset: number, value: bigint): void {
  for (let byte = 0; byte < 8; byte += 1) {
    buffer[offset + byte] = Number((value >> BigInt(byte * 8)) & 0xffn);
  }
}

function computeMethodSelector(): string {
  return keccak256(Buffer.from(METHOD_SIGNATURE, "utf8"))
    .subarray(0, 4)
    .toString("hex");
}
