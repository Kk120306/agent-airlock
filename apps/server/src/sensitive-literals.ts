export class SensitiveLiteralFilter {
  private readonly values: string[];

  constructor(values: readonly string[] = []) {
    this.values = [...new Set(values.filter((value) => value.length > 0))].sort(
      (left, right) => right.length - left.length,
    );
  }

  contains(value: string | Buffer): boolean {
    if (this.values.length === 0) return false;
    if (typeof value === "string") {
      return this.values.some((sensitive) => value.includes(sensitive));
    }
    return this.values.some((sensitive) =>
      value.includes(Buffer.from(sensitive, "utf8")),
    );
  }

  redact(value: string): string {
    return this.values.reduce(
      (redacted, sensitive) => redacted.split(sensitive).join("[REDACTED]"),
      value,
    );
  }
}
