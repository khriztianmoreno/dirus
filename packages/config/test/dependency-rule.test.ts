import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cruise } from "dependency-cruiser";
import { afterEach, describe, expect, it } from "vitest";

// The rule set lives at the repo root so `pnpm lint:deps` can reuse it
// unmodified; this test invokes it programmatically per design.md D-H.
const cruiserConfigPath = fileURLToPath(
  new URL("../../../.dependency-cruiser.cjs", import.meta.url),
);

let fixtureDir: string | undefined;

afterEach(() => {
  if (fixtureDir) {
    rmSync(fixtureDir, { recursive: true, force: true });
    fixtureDir = undefined;
  }
});

/** Writes a fixture workspace (apps/*, packages/*) to a fresh temp directory. */
function makeFixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "dirus-depcruise-"));
  for (const [relPath, content] of Object.entries(files)) {
    const fullPath = join(dir, relPath);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content);
  }
  return dir;
}

/** Runs the root dependency-cruiser rule set against a fixture directory. */
async function runCruiser(dir: string) {
  const { default: ruleSet } = (await import(cruiserConfigPath)) as {
    default: Record<string, unknown>;
  };
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    const result = await cruise(["apps", "packages"], {
      ruleSet,
      validate: true,
      outputType: "json",
    });
    const parsed =
      typeof result.output === "string"
        ? (JSON.parse(result.output) as {
            summary: {
              violations: Array<{ from: string; to: string; rule: { name: string } }>;
            };
          })
        : (result.output as unknown as {
            summary: {
              violations: Array<{ from: string; to: string; rule: { name: string } }>;
            };
          });
    return parsed.summary.violations;
  } finally {
    process.chdir(cwd);
  }
}

describe("workspace dependency boundary rules (workspace-foundation: Dependency Rule Enforcement)", () => {
  it("flags a package importing from an app", async () => {
    fixtureDir = makeFixture({
      "apps/api/src/index.ts": "export const apiValue = 1;\n",
      "packages/db/src/index.ts":
        'import { apiValue } from "../../../apps/api/src/index";\nexport const dbValue = apiValue;\n',
    });

    const violations = await runCruiser(fixtureDir);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      from: "packages/db/src/index.ts",
      to: "apps/api/src/index.ts",
      rule: { name: "no-packages-to-apps" },
    });
  });

  it("flags one app importing from another app", async () => {
    fixtureDir = makeFixture({
      "apps/api/src/index.ts": "export const apiValue = 1;\n",
      "apps/jobs/src/index.ts":
        'import { apiValue } from "../../api/src/index";\nexport const jobsValue = apiValue;\n',
      "packages/schemas/src/index.ts": "export const schemasValue = 1;\n",
    });

    const violations = await runCruiser(fixtureDir);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      from: "apps/jobs/src/index.ts",
      to: "apps/api/src/index.ts",
      rule: { name: "no-app-to-app" },
    });
  });

  it("passes with zero violations for a compliant workspace", async () => {
    fixtureDir = makeFixture({
      "apps/api/src/index.ts":
        'import { schemasValue } from "../../../packages/schemas/src/index";\nexport const apiValue = schemasValue;\n',
      "apps/jobs/src/index.ts": "export const jobsValue = 1;\n",
      "packages/schemas/src/index.ts": "export const schemasValue = 1;\n",
      "packages/db/src/index.ts":
        'import { schemasValue } from "../schemas/src/index";\nexport const dbValue = schemasValue;\n',
    });

    const violations = await runCruiser(fixtureDir);

    expect(violations).toEqual([]);
  });
});
