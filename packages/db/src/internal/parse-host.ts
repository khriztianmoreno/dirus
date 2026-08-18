/**
 * Shared by `./client.ts` and `./admin.ts`: extracts `.host` from a
 * connection string env var, or throws a descriptive error if the value is
 * not a well-formed URL.
 *
 * SECURITY: the catch branch below must NEVER interpolate any portion of
 * `url` into the thrown message. A standard connection string looks like
 * `postgres://user:pass@host/db` — the scheme is 11 characters, so even a
 * short slice (e.g. the first 20 characters) reproduces the username and
 * password verbatim. Since the value failed to parse, its structure is
 * unknown, so there is no safe way to redact it by parsing either — the
 * only safe choice is to emit nothing derived from the raw value at all.
 */
export function parseHost(envVarName: string, url: string): string {
  try {
    return new URL(url).host;
  } catch {
    throw new Error(
      `${envVarName} is not a well-formed connection URL. Expected a postgres:// URL, e.g. ` +
        "postgres://user:pass@host/db — a libpq keyword/value string " +
        '("host=... dbname=...") is not accepted here. (The value itself is not included in ' +
        "this message to avoid leaking credentials into logs.)",
    );
  }
}
