// Default env for tests that don't specifically exercise the connection
// guards (design.md D-B). `client-env-guards.test.ts` deletes/overrides
// these per test via `beforeEach`/`vi.resetModules()`.
process.env.DATABASE_URL ??=
  "postgres://user:pass@ep-cool-thing-pooler.us-east-2.aws.neon.tech/dirus";
process.env.DATABASE_URL_UNPOOLED ??=
  "postgres://user:pass@ep-cool-thing.us-east-2.aws.neon.tech/dirus";
