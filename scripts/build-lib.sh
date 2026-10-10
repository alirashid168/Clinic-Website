#!/usr/bin/env bash
# Type-checks the shared clinic logic (src/lib/*.ts) and writes the browser
# copies to web/js/lib/. Run after editing anything in src/lib.
set -euo pipefail
cd "$(dirname "$0")/.."
tsc src/lib/protocol.ts src/lib/legacy.ts src/lib/permissions.ts src/lib/autosave.ts src/lib/hours.ts src/lib/portal-login.ts \
  --target es2022 --module esnext --moduleResolution bundler \
  --allowImportingTsExtensions --rewriteRelativeImportExtensions \
  --outDir web/js/lib --skipLibCheck --lib es2022,dom --strict
# Only the six files that have a .ts source get the header (aaj.js and
# healthwire.js are hand-written).
for f in autosave hours legacy permissions portal-login protocol; do
  sed -i '1i // GENERATED from src/lib by scripts/build-lib.sh. Edit the .ts file, not this one.' "web/js/lib/$f.js"
done
# The admin-users Edge Function is deployed on its own (Deno bundles only the function's folder), so it gets a copy of
# the portal login rules. tests/portal-login.test.ts fails when this copy is not the current source.
{ echo '// COPY of src/lib/portal-login.ts made by scripts/build-lib.sh. Edit the source, not this file.'; cat src/lib/portal-login.ts; } > supabase/functions/admin-users/portal-login.ts
echo "web/js/lib rebuilt"
