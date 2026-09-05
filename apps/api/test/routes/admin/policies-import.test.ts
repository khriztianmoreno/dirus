import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { AppVariables } from "../../../src/app.js";
import {
  registerAdminPoliciesImportRoute,
  type ImportPolicyRowsFn,
} from "../../../src/routes/admin/policies-import.js";
import type { ResolveBrokerExists } from "../../../src/services/import-policies.js";

/**
 * Phase 6 (proposal Approach, spec "Response Reports Per-Row Outcome and
 * File-Level Totals"). Pure composition: this suite exercises the WIRED
 * route (admin-auth -> guards -> import service -> response), never the
 * internals of any of those three pieces individually — those already have
 * their own tests from Phases 3-5.
 *
 * Entirely offline, mirroring `app.test.ts`/`chatwoot.test.ts`'s injected-
 * fake convention: `resolveBrokerExists` and `importPolicyRows` are both
 * fakes here, and `registerAdminPoliciesImportRoute` (like `runImportGuards`
 * and `parseImportFile`) imports nothing from `@dirus/db` — see the
 * "offline-testability" test below, which asserts this from this file's own
 * import graph rather than merely by convention.
 */
const ADMIN_TOKEN = "a".repeat(32);

function buildApp(opts: {
  resolveBrokerExists?: ResolveBrokerExists;
  importPolicyRows?: ImportPolicyRowsFn;
} = {}) {
  const resolveBrokerExists = opts.resolveBrokerExists ?? (async () => true);
  const importPolicyRows =
    opts.importPolicyRows ??
    (vi.fn(async (brokerId: string) => ({
      brokerId,
      totals: { rows: 0, inserted: 0, updated: 0, failed: 0 },
      rows: [],
    })) as unknown as ImportPolicyRowsFn);

  const app = new Hono<{ Variables: AppVariables }>();
  registerAdminPoliciesImportRoute(app, {
    adminToken: ADMIN_TOKEN,
    resolveBrokerExists,
    importPolicyRows,
  });

  return { app, importPolicyRows };
}

function buildMultipartBody(opts: { brokerId?: string; filename?: string; content?: string }) {
  const form = new FormData();
  if (opts.brokerId !== undefined) {
    form.set("brokerId", opts.brokerId);
  }
  if (opts.content !== undefined) {
    form.set(
      "file",
      new File([opts.content], opts.filename ?? "policies.csv", { type: "text/csv" }),
    );
  }
  return form;
}

function post(app: Hono<{ Variables: AppVariables }>, form: FormData, token: string | undefined = ADMIN_TOKEN) {
  const headers: Record<string, string> = {};
  if (token !== undefined) {
    headers["X-Dirus-Admin-Token"] = token;
  }
  return app.request("/admin/policies/import", { method: "POST", headers, body: form });
}

const HEADER_ROW = "insurer,line,endDate,phone";

describe("POST /admin/policies/import (Phase 6: pure composition of Phases 3-5)", () => {
  it("6.1: a file with 3 valid rows and 1 invalid row returns 200 with a full per-row report", async () => {
    const importPolicyRows: ImportPolicyRowsFn = vi.fn(async (brokerId, rows) => ({
      brokerId,
      totals: { rows: rows.length, inserted: 3, updated: 0, failed: 1 },
      rows: [
        { row: 1, status: "inserted", policyId: "p1", contactId: "c1" },
        { row: 2, status: "inserted", policyId: "p2", contactId: "c2" },
        { row: 3, status: "failed", errors: [{ field: "endDate", message: "Invalid date" }] },
        { row: 4, status: "inserted", policyId: "p4", contactId: "c4" },
      ],
    }));
    const { app } = buildApp({ importPolicyRows });

    const csv = [
      HEADER_ROW,
      "Sura,auto,2027-01-01,+573000000001",
      "Sura,auto,2027-01-02,+573000000002",
      "Sura,auto,not-a-date,+573000000003",
      "Sura,auto,2027-01-04,+573000000004",
    ].join("\n");

    const res = await post(app, buildMultipartBody({ brokerId: "broker-1", content: csv }));
    const body = (await res.json()) as { totals: { rows: number; failed: number }; rows: unknown[] };

    expect(res.status).toBe(200);
    expect(body.totals.rows).toBe(4);
    expect(body.totals.failed).toBe(1);
    expect(body.rows).toHaveLength(4);
    expect((body.rows[0] as { row: number }).row).toBe(1);
    expect((body.rows[3] as { row: number }).row).toBe(4);
  });

  it("6.2 composition: admin-auth rejects before the import service ever runs", async () => {
    const { app, importPolicyRows } = buildApp();

    const res = await post(app, buildMultipartBody({ brokerId: "broker-1", content: `${HEADER_ROW}\nSura,auto,2027-01-01,+573000000001` }), "wrong-token-wrong-length");

    expect(res.status).toBe(401);
    expect(importPolicyRows).not.toHaveBeenCalled();
  });

  it("6.2 composition: missing brokerId is a 4xx guard rejection, import service never runs", async () => {
    const { app, importPolicyRows } = buildApp();

    const res = await post(app, buildMultipartBody({ content: `${HEADER_ROW}\nSura,auto,2027-01-01,+573000000001` }));

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(importPolicyRows).not.toHaveBeenCalled();
  });

  it("6.2 composition: unknown brokerId is rejected 404 by the guard, import service never runs", async () => {
    const { app, importPolicyRows } = buildApp({ resolveBrokerExists: async () => false });

    const res = await post(app, buildMultipartBody({ brokerId: "unknown-broker", content: `${HEADER_ROW}\nSura,auto,2027-01-01,+573000000001` }));

    expect(res.status).toBe(404);
    expect(importPolicyRows).not.toHaveBeenCalled();
  });

  it("6.2 composition: a missing required header is rejected 4xx by the guard, import service never runs", async () => {
    const { app, importPolicyRows } = buildApp();

    const csvMissingEndDate = ["insurer,line,phone", "Sura,auto,+573000000001"].join("\n");
    const res = await post(app, buildMultipartBody({ brokerId: "broker-1", content: csvMissingEndDate }));

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(importPolicyRows).not.toHaveBeenCalled();
  });

  it("6.3: a file-level rejection (unknown brokerId) is a 4xx", async () => {
    const { app } = buildApp({ resolveBrokerExists: async () => false });

    const res = await post(app, buildMultipartBody({ brokerId: "unknown-broker", content: `${HEADER_ROW}\nSura,auto,2027-01-01,+573000000001` }));

    expect(res.status).toBe(404);
  });

  it("6.3: EVERY row failing is still HTTP 200, never a 4xx, once the file itself is authorized and well-formed", async () => {
    const importPolicyRows: ImportPolicyRowsFn = vi.fn(async (brokerId, rows) => ({
      brokerId,
      totals: { rows: rows.length, inserted: 0, updated: 0, failed: rows.length },
      rows: rows.map((_, index) => ({
        row: index + 1,
        status: "failed" as const,
        errors: [{ field: "endDate", message: "Invalid date" }],
      })),
    }));
    const { app } = buildApp({ importPolicyRows });

    const csv = [HEADER_ROW, "Sura,auto,not-a-date,+573000000001", "Sura,auto,also-bad,+573000000002"].join(
      "\n",
    );

    const res = await post(app, buildMultipartBody({ brokerId: "broker-1", content: csv }));
    const body = (await res.json()) as { totals: { failed: number } };

    expect(res.status).toBe(200);
    expect(body.totals.failed).toBe(2);
  });

  it("offline-testability (task 6.4): this route module's import graph never reaches @dirus/db", async () => {
    // Mirrors app.test.ts's own structural claim, verified the same way:
    // reading the route module's source text directly for any `@dirus/db`
    // import, rather than trusting the docstring. `importPolicyRows` and
    // `resolveBrokerExists` are both injected parameters (never imported as
    // values from `import-policies-writer.ts` or `@dirus/db`), so this
    // module is constructible and testable with fakes exactly like this
    // file does above.
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const source = readFileSync(
      fileURLToPath(new URL("../../../src/routes/admin/policies-import.ts", import.meta.url)),
      "utf-8",
    );

    expect(source).not.toMatch(/from\s+["']@dirus\/db["']/);

    // The only reference to `import-policies-writer.js` (which itself
    // imports `@dirus/db`) must be a TYPE-ONLY import — erased entirely at
    // compile time, never reaching this module's runtime import graph.
    const writerImportLines = source
      .split("\n")
      .filter((line) => line.includes("import-policies-writer.js"));
    expect(writerImportLines.length).toBeGreaterThan(0);
    for (const line of writerImportLines) {
      expect(line).toMatch(/^\s*import\s+type\s/);
    }
  });
});
