import { createHash } from "node:crypto";
import type { RunTransaction } from "./types.js";

export function promotionValidationEvidenceHash(
  transaction: Pick<RunTransaction, "validations">,
): string {
  return (
    "sha256:" +
    createHash("sha256")
      .update(JSON.stringify(transaction.validations))
      .digest("hex")
  );
}
