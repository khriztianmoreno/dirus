import { useEffect, useState, type FormEvent } from "react";
import { apiRequest } from "../api/client.js";
import type { ReviewQueueResponse, ReviewQueueRow } from "../api/types.js";

/**
 * `admin-dashboard` (C1) task 7.7, design.md D-E. Lists flagged
 * extractions via Phase 5's `GET /api/dashboard/review-queue`, renders
 * per-field value/confidence, and a correction form per row —
 * `POST /api/dashboard/review-queue/:id/correction` via `client.ts`
 * (never `fetch()` directly, task 7.3).
 *
 * `toEnvelope`'s fallback marker (`{ ok: false, raw }`, design.md D-E) is
 * handled explicitly per row by degrading to a raw-JSON `<pre>` block —
 * this route never crashes on an unrecognized shape, mirroring the
 * backend's own "never throws" discipline for the exact same reason: B2
 * (`ingestion-agent`) does not exist yet, so most rows are expected to hit
 * this fallback today.
 */
function CorrectionForm({ row, onSaved }: { row: ReviewQueueRow; onSaved: () => void }) {
  const [draft, setDraft] = useState<string>(() => {
    const initial =
      row.envelope.ok
        ? Object.fromEntries(Object.entries(row.envelope.fields).map(([field, data]) => [field, data.value]))
        : row.envelope.raw.output;
    return JSON.stringify(initial, null, 2);
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    let correctedOutput: Record<string, unknown>;
    try {
      correctedOutput = JSON.parse(draft);
    } catch {
      setError("Corrected output must be valid JSON.");
      return;
    }

    setSaving(true);
    try {
      await apiRequest(`/dashboard/review-queue/${row.id}/correction`, {
        method: "POST",
        body: { correctedOutput },
      });
      onSaved();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Correction failed.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      <textarea
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        rows={6}
        disabled={saving}
      />
      {error ? <p role="alert">{error}</p> : null}
      <button type="submit" disabled={saving}>
        Save correction
      </button>
    </form>
  );
}

function EnvelopeFields({ envelope }: { envelope: ReviewQueueRow["envelope"] }) {
  if (!envelope.ok) {
    // design.md D-E fallback marker — degrade to raw JSON, never crash.
    return (
      <div>
        <p>Unrecognized extraction shape — showing raw data.</p>
        <pre>{JSON.stringify(envelope.raw, null, 2)}</pre>
      </div>
    );
  }

  return (
    <table>
      <thead>
        <tr>
          <th>Field</th>
          <th>Value</th>
          <th>Confidence</th>
        </tr>
      </thead>
      <tbody>
        {Object.entries(envelope.fields).map(([field, data]) => (
          <tr key={field}>
            <td>{field}</td>
            <td>{JSON.stringify(data.value)}</td>
            <td>{(data.confidence * 100).toFixed(0)}%</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function ReviewQueueRoute() {
  const [rows, setRows] = useState<ReviewQueueRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setError(null);

    apiRequest<ReviewQueueResponse>("/dashboard/review-queue")
      .then((response) => {
        if (!cancelled) {
          setRows(response.rows);
        }
      })
      .catch((loadError) => {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : "Failed to load review queue.");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [reloadToken]);

  return (
    <main>
      <h1>Review queue</h1>
      {error ? <p role="alert">{error}</p> : null}
      {rows === null && !error ? <p>Loading…</p> : null}
      {rows !== null && rows.length === 0 ? <p>Nothing flagged for review.</p> : null}
      {rows?.map((row) => (
        <section key={row.id}>
          <h2>{row.id}</h2>
          <EnvelopeFields envelope={row.envelope} />
          <CorrectionForm row={row} onSaved={() => setReloadToken((token) => token + 1)} />
        </section>
      ))}
    </main>
  );
}
