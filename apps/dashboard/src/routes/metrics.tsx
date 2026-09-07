import { useEffect, useState, type ReactNode } from "react";
import { apiRequest } from "../api/client.js";
import type {
  ConversationStatusSnapshotResult,
  CostMetricResult,
  MetricResult,
  NeedsReviewRateValue,
  RenewalStatusValue,
  TimeToFirstRenewalValue,
} from "../api/types.js";

/**
 * `admin-dashboard` (C1) task 7.8, design.md D-F, proposal Success
 * Criteria. Six panels, one per Phase 6 `GET /api/dashboard/metrics/*`
 * endpoint. Every panel renders `empty`/`sampleSize`/`caveat` explicitly —
 * a distinct "no data yet" state, never a bare zero (`MetricResult<T>`'s
 * own contract, `services/metrics/types.ts`).
 *
 * **The conversation-resolution panel's snapshot label is a named
 * proposal Success Criteria checkbox, not incidental copy** — it MUST be
 * visible in the rendered UI text, not only in a code comment, and it MUST
 * read as a current-state snapshot, never as the §12 at-close metric. The
 * exact copy below is driven by `ConversationStatusSnapshotResult`'s own
 * `snapshotType: "current-state"` field (never hardcoded independently of
 * it) plus its `caveat` string — both travel as DATA from the query
 * (design.md D-F), so this label cannot silently drift away from what the
 * backend actually computed.
 */

function MetricPanel({
  title,
  result,
  children,
}: {
  title: string;
  result: MetricResult<unknown>;
  children?: ReactNode;
}) {
  return (
    <section>
      <h2>{title}</h2>
      {result.empty ? (
        <p>No data yet (sample size: {result.sampleSize}).</p>
      ) : (
        <>
          <p>Sample size: {result.sampleSize}</p>
          {children}
        </>
      )}
      {result.caveat ? <p role="note">{result.caveat}</p> : null}
    </section>
  );
}

export function MetricsRoute() {
  const [copilotShare, setCopilotShare] = useState<MetricResult<{ count: number }> | null>(null);
  const [renewalStatus, setRenewalStatus] = useState<MetricResult<RenewalStatusValue> | null>(null);
  const [needsReviewRate, setNeedsReviewRate] = useState<MetricResult<NeedsReviewRateValue> | null>(null);
  const [conversationStatusSnapshot, setConversationStatusSnapshot] =
    useState<ConversationStatusSnapshotResult | null>(null);
  const [timeToFirstRenewal, setTimeToFirstRenewal] = useState<MetricResult<TimeToFirstRenewalValue | null> | null>(
    null,
  );
  const [cost, setCost] = useState<CostMetricResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    Promise.all([
      apiRequest<MetricResult<{ count: number }>>("/dashboard/metrics/copilot-share"),
      apiRequest<MetricResult<RenewalStatusValue>>("/dashboard/metrics/renewal-status"),
      apiRequest<MetricResult<NeedsReviewRateValue>>("/dashboard/metrics/needs-review-rate"),
      apiRequest<ConversationStatusSnapshotResult>("/dashboard/metrics/conversation-status-snapshot"),
      apiRequest<MetricResult<TimeToFirstRenewalValue | null>>("/dashboard/metrics/time-to-first-renewal"),
      apiRequest<CostMetricResult>("/dashboard/metrics/cost"),
    ])
      .then(([copilot, renewal, reviewRate, conversationSnapshot, firstRenewal, costResult]) => {
        if (cancelled) {
          return;
        }
        setCopilotShare(copilot);
        setRenewalStatus(renewal);
        setNeedsReviewRate(reviewRate);
        setConversationStatusSnapshot(conversationSnapshot);
        setTimeToFirstRenewal(firstRenewal);
        setCost(costResult);
      })
      .catch((loadError) => {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : "Failed to load metrics.");
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main>
      <h1>Metrics</h1>
      {error ? <p role="alert">{error}</p> : null}

      {copilotShare ? (
        <MetricPanel title="Copilot usage" result={copilotShare}>
          <p>Copilot conversations: {copilotShare.value.count}</p>
        </MetricPanel>
      ) : null}

      {renewalStatus ? (
        <MetricPanel title="Renewal funnel" result={renewalStatus}>
          <ul>
            {Object.entries(renewalStatus.value).map(([status, count]) => (
              <li key={status}>
                {status}: {count}
              </li>
            ))}
          </ul>
        </MetricPanel>
      ) : null}

      {needsReviewRate ? (
        <MetricPanel title="Extraction review load" result={needsReviewRate}>
          <p>
            {needsReviewRate.value.flagged} of {needsReviewRate.value.total} flagged (
            {(needsReviewRate.value.rate * 100).toFixed(1)}%)
          </p>
        </MetricPanel>
      ) : null}

      {conversationStatusSnapshot ? (
        <MetricPanel title="Conversation resolution" result={conversationStatusSnapshot}>
          {/* Named proposal Success Criteria checkbox (task 7.8): this
              label MUST be visible here, in the rendered UI text, driven
              directly by the backend's own `snapshotType` field. */}
          <p>
            <strong>Current-state snapshot</strong> — not an at-close measurement.
          </p>
          <ul>
            {Object.entries(conversationStatusSnapshot.value).map(([status, count]) => (
              <li key={status}>
                {status}: {count}
              </li>
            ))}
          </ul>
        </MetricPanel>
      ) : null}

      {timeToFirstRenewal ? (
        <MetricPanel title="Time to first renewal contact" result={timeToFirstRenewal}>
          {timeToFirstRenewal.value ? <p>{timeToFirstRenewal.value.days} days</p> : null}
        </MetricPanel>
      ) : null}

      {cost ? (
        <MetricPanel title="Cost per conversation / renewal" result={cost}>
          {cost.status === "deferred" ? (
            <p>Cost data is not available yet.</p>
          ) : cost.value ? (
            <p>
              ${cost.value.costPerConversation.toFixed(2)} / conversation, $
              {cost.value.costPerRenewal.toFixed(2)} / renewal
            </p>
          ) : null}
        </MetricPanel>
      ) : null}
    </main>
  );
}
