export type CanonicalJsonValue =
  | null
  | boolean
  | number
  | string
  | CanonicalJsonValue[]
  | { [key: string]: CanonicalJsonValue };

export const MAXIMUM_CANONICAL_DOCUMENT_BYTES = 1_048_576;
const MAX_DEPTH = 64;
const MAX_NODES = 50_000;

export function canonicalize(value: unknown): string {
  return serialize(assertCanonicalJsonValue(value));
}

export function parseCanonicalJson(
  source: string,
  maximumBytes = MAXIMUM_CANONICAL_DOCUMENT_BYTES,
): CanonicalJsonValue {
  if (utf8Bytes(source).length > maximumBytes) {
    throw new Error("JSON input exceeds the byte limit");
  }
  const parser = new StrictJsonParser(source);
  return parser.parse();
}

export function utf8Bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

export function assertCanonicalJsonValue(value: unknown): CanonicalJsonValue {
  return assertCanonicalJsonValueWithinBudget(value, 0, { nodes: 0 });
}

function assertCanonicalJsonValueWithinBudget(
  value: unknown,
  depth: number,
  budget: { nodes: number },
): CanonicalJsonValue {
  if (depth > MAX_DEPTH) {
    throw new Error("JSON value exceeds the depth limit");
  }
  budget.nodes += 1;
  if (budget.nodes > MAX_NODES) {
    throw new Error("JSON value exceeds the node limit");
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    assertValidUnicode(value);
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new Error("JSON numbers must be safe integers");
    }
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_NODES) {
      throw new Error("JSON array exceeds the item limit");
    }
    return value.map((item) =>
      assertCanonicalJsonValueWithinBudget(item, depth + 1, budget),
    );
  }
  if (typeof value !== "object" || value === undefined) {
    throw new Error("Value is not canonical JSON");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("JSON objects must be plain objects");
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_NODES) {
    throw new Error("JSON object exceeds the property limit");
  }
  const result: Record<string, CanonicalJsonValue> = Object.create(null);
  for (const [key, item] of entries) {
    assertValidUnicode(key);
    result[key] = assertCanonicalJsonValueWithinBudget(item, depth + 1, budget);
  }
  return result;
}

export function assertValidUnicode(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isFinite(next) || next < 0xdc00 || next > 0xdfff) {
        throw new Error("JSON string contains an unpaired high surrogate");
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new Error("JSON string contains an unpaired low surrogate");
    }
  }
}

function serialize(value: CanonicalJsonValue): string {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(serialize).join(",")}]`;
  return `{${Object.keys(value)
    .sort(compareUtf16)
    .map((key) => `${JSON.stringify(key)}:${serialize(value[key]!)}`)
    .join(",")}}`;
}

class StrictJsonParser {
  private index = 0;
  private nodes = 0;

  constructor(private readonly source: string) {}

  parse(): CanonicalJsonValue {
    this.skipWhitespace();
    const value = this.parseValue(0);
    this.skipWhitespace();
    if (this.index !== this.source.length) {
      throw new Error("JSON input has trailing content");
    }
    return value;
  }

  private parseValue(depth: number): CanonicalJsonValue {
    if (depth > MAX_DEPTH) throw new Error("JSON input exceeds the depth limit");
    this.nodes += 1;
    if (this.nodes > MAX_NODES) throw new Error("JSON input exceeds the node limit");
    const next = this.source[this.index];
    if (next === "{") return this.parseObject(depth + 1);
    if (next === "[") return this.parseArray(depth + 1);
    if (next === '"') return this.parseString();
    if (next === "t") return this.parseLiteral("true", true);
    if (next === "f") return this.parseLiteral("false", false);
    if (next === "n") return this.parseLiteral("null", null);
    return this.parseNumber();
  }

  private parseObject(depth: number): { [key: string]: CanonicalJsonValue } {
    this.index += 1;
    this.skipWhitespace();
    const result: Record<string, CanonicalJsonValue> = Object.create(null);
    const keys = new Set<string>();
    if (this.source[this.index] === "}") {
      this.index += 1;
      return result;
    }
    while (true) {
      if (this.source[this.index] !== '"') {
        throw new Error("JSON object key must be a string");
      }
      const key = this.parseString();
      if (keys.has(key)) throw new Error("JSON object has a duplicate key");
      keys.add(key);
      this.skipWhitespace();
      this.expect(":");
      this.skipWhitespace();
      result[key] = this.parseValue(depth);
      this.skipWhitespace();
      const separator = this.source[this.index];
      if (separator === "}") {
        this.index += 1;
        return result;
      }
      this.expect(",");
      this.skipWhitespace();
    }
  }

  private parseArray(depth: number): CanonicalJsonValue[] {
    this.index += 1;
    this.skipWhitespace();
    const result: CanonicalJsonValue[] = [];
    if (this.source[this.index] === "]") {
      this.index += 1;
      return result;
    }
    while (true) {
      result.push(this.parseValue(depth));
      this.skipWhitespace();
      const separator = this.source[this.index];
      if (separator === "]") {
        this.index += 1;
        return result;
      }
      this.expect(",");
      this.skipWhitespace();
    }
  }

  private parseString(): string {
    const start = this.index;
    this.index += 1;
    while (this.index < this.source.length) {
      const code = this.source.charCodeAt(this.index);
      if (code === 0x22) {
        this.index += 1;
        const token = this.source.slice(start, this.index);
        let value: string;
        try {
          value = JSON.parse(token) as string;
        } catch {
          throw new Error("JSON string escape is invalid");
        }
        assertValidUnicode(value);
        return value;
      }
      if (code === 0x5c) {
        this.index += 1;
        if (this.index >= this.source.length) break;
        if (this.source[this.index] === "u") {
          if (!/^[0-9a-fA-F]{4}$/.test(this.source.slice(this.index + 1, this.index + 5))) {
            throw new Error("JSON Unicode escape is invalid");
          }
          this.index += 5;
          continue;
        }
        if (!'"\\/bfnrt'.includes(this.source[this.index]!)) {
          throw new Error("JSON string escape is invalid");
        }
        this.index += 1;
      } else {
        if (code <= 0x1f) throw new Error("JSON string contains a control character");
        this.index += 1;
      }
    }
    throw new Error("JSON string is unterminated");
  }

  private parseNumber(): number {
    const token = this.source.slice(this.index).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/)?.[0];
    if (!token) throw new Error("JSON value is invalid");
    this.index += token.length;
    const value = Number(token);
    if (!Number.isSafeInteger(value)) {
      throw new Error("JSON numbers must be safe integers");
    }
    return value;
  }

  private parseLiteral<T extends boolean | null>(token: string, value: T): T {
    if (!this.source.startsWith(token, this.index)) {
      throw new Error("JSON literal is invalid");
    }
    this.index += token.length;
    return value;
  }

  private skipWhitespace(): void {
    while (
      this.source[this.index] === " " ||
      this.source[this.index] === "\t" ||
      this.source[this.index] === "\r" ||
      this.source[this.index] === "\n"
    ) {
      this.index += 1;
    }
  }

  private expect(value: string): void {
    if (this.source[this.index] !== value) {
      throw new Error(`Expected ${value} in JSON input`);
    }
    this.index += 1;
  }
}

function compareUtf16(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
