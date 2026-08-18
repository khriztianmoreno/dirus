#!/usr/bin/env bash
#
# Submit the HSM message templates in ./templates to a WhatsApp Business
# Account for Meta review.
#
# Template approval is per-WABA: templates approved on the sandbox WABA do NOT
# carry over to a broker's production WABA. Re-run this script (or its
# programmatic equivalent) once per broker during onboarding.
#
# Usage:
#   WABA_ID=... WHATSAPP_TOKEN=... ./submit.sh              # submit all
#   WABA_ID=... WHATSAPP_TOKEN=... ./submit.sh 90 91        # submit by prefix
#
set -euo pipefail

GRAPH_VERSION="${GRAPH_VERSION:-v23.0}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE_DIR="$SCRIPT_DIR/templates"

: "${WABA_ID:?set WABA_ID (WhatsApp Business Account id)}"
: "${WHATSAPP_TOKEN:?set WHATSAPP_TOKEN (needs whatsapp_business_management)}"

command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }

files=()
if [ "$#" -eq 0 ]; then
  while IFS= read -r f; do files+=("$f"); done < <(find "$TEMPLATE_DIR" -name '*.json' | sort)
else
  for prefix in "$@"; do
    while IFS= read -r f; do files+=("$f"); done < <(find "$TEMPLATE_DIR" -name "${prefix}-*.json" | sort)
  done
fi

[ "${#files[@]}" -gt 0 ] || { echo "no templates matched" >&2; exit 1; }

failed=0
for file in "${files[@]}"; do
  name="$(jq -r .name "$file")"
  echo "--- submitting $name ($(basename "$file"))"

  response="$(curl -sS -X POST \
    "https://graph.facebook.com/$GRAPH_VERSION/$WABA_ID/message_templates" \
    -H "Authorization: Bearer $WHATSAPP_TOKEN" \
    -H "Content-Type: application/json" \
    --data-binary "@$file")"

  if echo "$response" | jq -e '.error' >/dev/null 2>&1; then
    echo "    REJECTED BY API: $(echo "$response" | jq -c '.error.message, .error.error_user_msg')" >&2
    failed=1
  else
    echo "    id=$(echo "$response" | jq -r '.id')  status=$(echo "$response" | jq -r '.status')"
  fi
done

exit "$failed"
