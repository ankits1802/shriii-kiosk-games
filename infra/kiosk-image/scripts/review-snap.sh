#!/bin/sh
# Run the Snap Store's review-tools on a built snap and fail on any error except the ones a brand store
# resolves by assertion (super-privileged interfaces and the gadget snap type).
#
#   sh infra/kiosk-image/scripts/review-snap.sh <file.snap>      -> review-tools.json in the working dir
set -eu

snap_file="$1"
command -v review-tools.snap-review >/dev/null 2>&1 || sudo snap install review-tools

# review-tools is strictly confined (home interface): review a copy under $HOME.
work="$HOME/review-$$"
mkdir -p "$work"
cp "$snap_file" "$work/"
rc=0
review-tools.snap-review --json "$work/$(basename "$snap_file")" >review-tools.json || rc=$?
rm -rf "$work"
echo "snap-review exit code: $rc"

# Expected manual-review items (granted by the brand store's snap-declaration assertions):
expected='snapd-control|firewall-control|custom-device|snap_type_redflag|gadget|plugs_installation|plugs_connection|slots_installation'

python3 - "$expected" <<'EOF'
import json, re, sys

expected = re.compile(sys.argv[1])
report = json.load(open("review-tools.json"))
unexpected, allowed, warnings = [], [], []
for section, results in report.items():
    if not isinstance(results, dict):
        continue
    for key, item in (results.get("error") or {}).items():
        text = f"{section} {key}: {item.get('text', '')}"
        (allowed if expected.search(key) or expected.search(item.get("text", "")) else unexpected).append(text)
    for key, item in (results.get("warn") or {}).items():
        warnings.append(f"{section} {key}: {item.get('text', '')}")
for line in warnings:
    print(f"::warning::{line}")
for line in allowed:
    print(f"expected (store assertion): {line}")
for line in unexpected:
    print(f"::error::{line}")
print(f"review-tools: {len(unexpected)} unexpected errors, {len(allowed)} expected, {len(warnings)} warnings")
sys.exit(1 if unexpected else 0)
EOF
