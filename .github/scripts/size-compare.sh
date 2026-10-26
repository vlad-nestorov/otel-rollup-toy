#!/usr/bin/env bash
# Temporary: reports bundle sizes for main (checked out at $RUNNER_TEMP/main) and this branch.
set -euo pipefail
r=.github/scripts/size-report.mjs
LABEL="main: app" node "$r" "$RUNNER_TEMP/main/app"
npm run build -w sdk --silent > /dev/null
LABEL="branch: sdk prebundle" node "$r" sdk
LABEL="branch: app" node "$r" app
# Same prebundle with commonjs({ strictRequires: 'auto' }), to see if unwrapped modules shake better.
sed "s/commonjs()]/commonjs({ strictRequires: 'auto' })]/" sdk/rollup.config.js > sdk/rollup.config.auto.js
grep -q strictRequires sdk/rollup.config.auto.js
(cd sdk && npx --no-install rollup -c rollup.config.auto.js --silent)
LABEL="branch, strictRequires auto: sdk prebundle" node "$r" sdk rollup.config.auto.js
LABEL="branch, strictRequires auto: app" node "$r" app
