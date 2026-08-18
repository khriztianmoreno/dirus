#!/usr/bin/env bash
#
# List every message template on the WABA with its review status and category.
# Meta may silently re-categorize a UTILITY template as MARKETING — that
# changes the per-conversation price, so check `category` here, not just
# `status`.
#
# Usage:
#   WABA_ID=... WHATSAPP_TOKEN=... ./status.sh
#
set -euo pipefail

GRAPH_VERSION="${GRAPH_VERSION:-v23.0}"

: "${WABA_ID:?set WABA_ID (WhatsApp Business Account id)}"
: "${WHATSAPP_TOKEN:?set WHATSAPP_TOKEN (needs whatsapp_business_management)}"

command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }

curl -sS -G \
  "https://graph.facebook.com/$GRAPH_VERSION/$WABA_ID/message_templates" \
  -H "Authorization: Bearer $WHATSAPP_TOKEN" \
  --data-urlencode "fields=name,language,status,category,rejected_reason,quality_score" \
  --data-urlencode "limit=100" |
  jq -r '
    (["NAME","LANG","STATUS","CATEGORY","REJECTED_REASON"] | @tsv),
    (.data[] | [.name, .language, .status, .category, (.rejected_reason // "-")] | @tsv)
  ' | column -t -s $'\t'
