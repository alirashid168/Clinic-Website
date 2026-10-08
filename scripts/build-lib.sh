#!/usr/bin/env bash
# Type-checks the shared clinic logic (src/lib/*.ts) and writes the browser
# copies to web/js/lib/. Run after editing anything in src/lib.
set -euo pipefail
cd "$(dirname "$0")/.."
tsc src/lib/protocol.ts src/lib/legacy.ts src/lib/permissions.ts src/lib/autosave.ts src/lib/hours.ts \
  --target es2022 --module esnext --moduleResolution bundler \
  --allowImportingTsExtensions --rewriteRelativeImportExtensions \
  --outDir web/js/lib --skipLibCheck --lib es2022,dom --strict
# Only the five files that have a .ts source get the header (aaj.js and
# healthwire.js are hand-written).
for f in autosave hours legacy permissions protocol; do
  sed -i '1i // GENERATED from src/lib by scripts/build-lib.sh. Edit the .ts file, not this one.' "web/js/lib/$f.js"
done
echo "web/js/lib rebuilt"
