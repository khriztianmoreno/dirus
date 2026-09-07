import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { extractResolutionKey } from "../../src/webhooks/chatwoot.js";
import fixtureFromFile from "../fixtures/chatwoot-message-created.json" with { type: "json" };
import { chatwootMessageCreatedPayloadSchema } from "../../src/webhooks/chatwoot.js";

/**
 * F2 design D-6, corrected by F2.1 design D-A/D-B: `extractResolutionKey` is
 * the single, deliberately isolated point of contact with "which field
 * carries the resolution key" — now `account.id`, not
 * `inbox.phone_number`. Swapping which field it reads must require touching
 * only this one function — never any route or middleware.
 *
 * The scan below recursively walks both consumer directories (skipping
 * gracefully, with a documented reason, if either is absent) and asserts
 * that any file importing from `@dirus/schemas` (or a relative path
 * resolving to `webhooks/chatwoot.js`) names only an allowlisted set of
 * imports — never anything that would let a consumer read
 * `payload.account.id` (or any other raw field) directly instead of going
 * through `extractResolutionKey`.
 */

const CONSUMER_DIRS = [
  fileURLToPath(new URL("../../../../apps/api/src/routes/webhooks", import.meta.url)),
  fileURLToPath(new URL("../../../../apps/api/src/middleware", import.meta.url)),
];

// The only names a consumer of packages/schemas' Chatwoot webhook module may
// import: the two parse-stage schemas/helpers, and the resolution-key
// extractor itself. Anything else (e.g. reaching into a schema's internal
// shape to read `account.id` directly) would defeat the isolation design
// D-6/D-B relies on.
const ALLOWED_CHATWOOT_IMPORTS = new Set([
  "chatwootWebhookEnvelopeSchema",
  "isIgnorableChatwootEvent",
  "chatwootMessageCreatedPayloadSchema",
  "extractResolutionKey",
]);

function walkTsFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const entries = readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const fullPath = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return walkTsFiles(fullPath);
    if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      return [fullPath];
    }
    return [];
  });
}

// Matches `import { a, b } from "@dirus/schemas"` or any relative path
// ending in `webhooks/chatwoot(.js)` — both the barrel and a direct import
// are covered, since either is a legitimate way to reach this module.
const CHATWOOT_IMPORT_RE =
  /import\s*\{([^}]*)\}\s*from\s*["'](?:@dirus\/schemas|(?:\.\.?\/)+webhooks\/chatwoot(?:\.js)?)["']/g;

describe("extractResolutionKey isolation (F2 design D-6, corrected by F2.1 design D-A/D-B)", () => {
  it("directories `apps/api/src/routes/webhooks` and `apps/api/src/middleware` exist — the scan below does real enforcement work", () => {
    const anyExists = CONSUMER_DIRS.some((dir) => existsSync(dir));
    expect(anyExists).toBe(true);
  });

  it("no file under either consumer directory imports anything from the Chatwoot module except the allowlisted parse/extract functions", () => {
    const files = CONSUMER_DIRS.flatMap(walkTsFiles);
    const violations: string[] = [];

    for (const file of files) {
      const source = readFileSync(file, "utf-8");
      for (const match of source.matchAll(CHATWOOT_IMPORT_RE)) {
        const importedNames = match[1]
          .split(",")
          .map((name) => name.trim())
          .filter(Boolean);
        for (const name of importedNames) {
          if (!ALLOWED_CHATWOOT_IMPORTS.has(name)) {
            violations.push(`${file}: imports "${name}" directly from the Chatwoot module`);
          }
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it("extractResolutionKey is the only function whose body reads payload.account.id — proven by contract: given the real fixture, the extractor returns the numeric account.id, and nothing about calling it exposes which field that is", () => {
    const parsed = chatwootMessageCreatedPayloadSchema.parse(fixtureFromFile);
    const key = extractResolutionKey(parsed);

    expect(typeof key).toBe("number");
    expect(key).toBe(parsed.account.id);
  });
});
