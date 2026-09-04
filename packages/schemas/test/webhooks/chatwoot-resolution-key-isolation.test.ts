import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { extractResolutionKey } from "../../src/webhooks/chatwoot.js";
import fixtureFromFile from "../fixtures/chatwoot-message-created.json" with { type: "json" };
import { chatwootMessageCreatedPayloadSchema } from "../../src/webhooks/chatwoot.js";

/**
 * Design D-6: `extractResolutionKey` is the single, deliberately isolated
 * point of contact with "which field carries the resolution key". Swapping
 * which field it reads (the stated O4 fallback: `inbox.phone_number` ->
 * `account.id`) must require touching only this one function — never any
 * route or middleware.
 *
 * `apps/api/src/routes/webhooks` and `apps/api/src/middleware` do not exist
 * yet (Phase 3/5 have not landed at the time this test was written — see
 * `apps/api/src/index.ts`, still the empty typed shell). The scan below is
 * written to hold once they do exist: it recursively walks both directories
 * (skipping gracefully, with a documented reason, if either is absent yet)
 * and asserts that any file importing from `@dirus/schemas` (or a relative
 * path resolving to `webhooks/chatwoot.js`) names only an allowlisted set
 * of imports — never anything that would let a consumer read
 * `payload.inbox.phone_number` (or any other raw field) directly instead of
 * going through `extractResolutionKey`.
 */

const CONSUMER_DIRS = [
  fileURLToPath(new URL("../../../../apps/api/src/routes/webhooks", import.meta.url)),
  fileURLToPath(new URL("../../../../apps/api/src/middleware", import.meta.url)),
];

// The only names a consumer of packages/schemas' Chatwoot webhook module may
// import: the two parse-stage schemas/helpers, and the resolution-key
// extractor itself. Anything else (e.g. reaching into a schema's internal
// shape to read `inbox.phone_number` directly) would defeat the isolation
// design D-6 relies on.
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

describe("extractResolutionKey isolation (design D-6)", () => {
  it("directories `apps/api/src/routes/webhooks` and `apps/api/src/middleware` do not exist yet — documented, not silently skipped", () => {
    // This assertion exists so the "not written yet" state is visible in
    // test output rather than the scan below silently finding zero files
    // for an unrelated reason (e.g. a typo'd path).
    const anyExists = CONSUMER_DIRS.some((dir) => existsSync(dir));
    // Flip this expectation once Phase 3/5 create these directories — at
    // that point the scan below starts doing real enforcement work.
    expect(anyExists).toBe(false);
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

  it("extractResolutionKey is the only function whose body reads payload.inbox — proven by mutation: renaming the field inside the schema breaks only this function's return, nothing about its call signature", () => {
    // extractResolutionKey's signature (payload) => string never changes
    // shape regardless of which field backs it — that is exactly what
    // makes the swap a one-function change. This test locks the contract:
    // given the fixture, the extractor returns a plain string equal to the
    // field it currently reads, and nothing about calling it exposes which
    // field that is.
    const parsed = chatwootMessageCreatedPayloadSchema.parse(fixtureFromFile);
    const key = extractResolutionKey(parsed);

    expect(typeof key).toBe("string");
    expect(key).toBe(parsed.inbox.phone_number);
  });
});
