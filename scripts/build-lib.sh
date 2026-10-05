#!/usr/bin/env bash
# Type-checks the shared clinic logic (src/lib/*.ts) and writes the browser
# copies to web/js/lib/. Run after editing anything in src/lib.
set -euo pipefail
cd "$(dirname "$0")/.."
tsc src/lib/protocol.ts src/lib/legacy.ts src/lib/permissions.ts src/lib/autosave.ts \
  --target es2022 --module esnext --moduleResolution bundler \
  --allowImportingTsExtensions --rewriteRelativeImportExtensions \
  --outDir web/js/lib --skipLibCheck --lib es2022,dom --strict
for f in web/js/lib/*.js; do
  sed -i '1i // GENERATED from src/lib by scripts/build-lib.sh. Edit the .ts file, not this one.' "$f"
done
echo "web/js/lib rebuilt"
