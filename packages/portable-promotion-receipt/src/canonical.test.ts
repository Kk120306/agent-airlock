import { describe, expect, it } from "vitest";
import {
  assertCanonicalJsonValue,
  canonicalize,
  parseCanonicalJson,
} from "./canonical.js";

describe("RFC 8785 canonical JSON boundary", () => {
  it("orders object names by UTF-16 code units and emits stable JSON", () => {
    const input = {
      "€": "Euro",
      "\r": "CR",
      "1": "one",
      "\u0080": "Control",
      "😀": "Emoji",
      "ö": "Latin",
    };
    expect(canonicalize(input)).toBe(
      "{\"\\r\":\"CR\",\"1\":\"one\",\"\":\"Control\",\"ö\":\"Latin\",\"€\":\"Euro\",\"😀\":\"Emoji\"}",
    );
    expect(canonicalize(parseCanonicalJson(JSON.stringify(input)))).toBe(
      canonicalize(input),
    );
  });

  it("rejects duplicate names, non-JSON whitespace, and unsafe numbers", () => {
    expect(() => parseCanonicalJson('{"a":1,"a":2}')).toThrow(/duplicate key/);
    expect(() => parseCanonicalJson("{\u00a0\"a\":1}")).toThrow();
    expect(() => parseCanonicalJson("9007199254740992")).toThrow(/safe integers/);
    expect(() => assertCanonicalJsonValue(Number.NaN)).toThrow(/safe integers/);
  });

  it("rejects invalid Unicode before canonicalization", () => {
    expect(() => canonicalize("\ud800")).toThrow(/unpaired high surrogate/);
    expect(() => parseCanonicalJson('"\\ud800"')).toThrow(
      /unpaired high surrogate/,
    );
  });

  it("enforces the node boundary across the whole object graph", () => {
    const value = Array.from({ length: 250 }, () =>
      Array.from({ length: 250 }, () => null),
    );
    expect(() => assertCanonicalJsonValue(value)).toThrow(/node limit/);
  });
});
