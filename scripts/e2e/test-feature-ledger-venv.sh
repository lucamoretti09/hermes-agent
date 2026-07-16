#!/usr/bin/env bash
# Prove a recorded lazy feature is restored into a replacement venv.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
if [ -n "${UV:-}" ]; then
    UV="$UV"
elif command -v uv >/dev/null 2>&1; then
    UV="$(command -v uv)"
else
    UV="$HOME/.hermes/bin/uv"
fi

WORK=$(mktemp -d)
FEATURE_HOME="$WORK/home"
WHEELS="$WORK/wheels"
V1="$WORK/v1"
V2="$WORK/v2"
mkdir -p "$FEATURE_HOME/state" "$WHEELS"
trap 'rm -rf "$WORK"' EXIT

python3 - "$WHEELS" <<'PY'
import base64
import csv
import hashlib
import io
import pathlib
import zipfile

root = pathlib.Path(__import__('sys').argv[1])
wheel = root / 'parallel_web-0.4.2-py3-none-any.whl'
files = {
    'parallel_web/__init__.py': b'E2E_MARKER = "ledger-restored"\n',
    'parallel_web-0.4.2.dist-info/METADATA': b'Metadata-Version: 2.1\nName: parallel-web\nVersion: 0.4.2\n',
    'parallel_web-0.4.2.dist-info/WHEEL': b'Wheel-Version: 1.0\nGenerator: hermes-e2e\nRoot-Is-Purelib: true\nTag: py3-none-any\n',
}
rows = []
for path, body in files.items():
    digest = base64.urlsafe_b64encode(hashlib.sha256(body).digest()).rstrip(b'=').decode()
    rows.append((path, f'sha256={digest}', str(len(body))))
record = 'parallel_web-0.4.2.dist-info/RECORD'
rows.append((record, '', ''))
out = io.StringIO(); csv.writer(out, lineterminator='\n').writerows(rows)
files[record] = out.getvalue().encode()
with zipfile.ZipFile(wheel, 'w', zipfile.ZIP_DEFLATED) as archive:
    for path, body in files.items(): archive.writestr(path, body)
PY

"$UV" venv "$V1" >/dev/null
"$UV" venv "$V2" >/dev/null
"$UV" pip install --python "$V1/bin/python" --no-deps -e "$REPO_ROOT" >/dev/null
"$UV" pip install --python "$V2/bin/python" --no-deps -e "$REPO_ROOT" >/dev/null

export HERMES_HOME="$FEATURE_HOME"
export PIP_FIND_LINKS="$WHEELS"
export PIP_NO_INDEX=1
export UV_FIND_LINKS="$WHEELS"
export UV_NO_INDEX=1
"$V1/bin/python" - <<'PY'
from tools.lazy_deps import ensure
ensure('search.parallel', prompt=False)
import parallel_web
assert parallel_web.E2E_MARKER == 'ledger-restored'
PY
"$V1/bin/python" -c 'import parallel_web'
if "$V2/bin/python" -c 'import parallel_web' 2>/dev/null; then
    echo 'replacement venv unexpectedly already contains the feature' >&2
    exit 1
fi
PYTHONPATH="$REPO_ROOT" python3 - "$V2/bin/python" <<'PY'
import json
import sys
from tools.lazy_deps import apply_ledger
result = apply_ledger(sys.argv[1])
assert result.get('search.parallel') == 'refreshed', json.dumps(result, sort_keys=True)
PY
"$V2/bin/python" - <<'PY'
import parallel_web
assert parallel_web.E2E_MARKER == 'ledger-restored'
PY
printf 'E2E_PASS: lazy feature restored into replacement venv\n'
