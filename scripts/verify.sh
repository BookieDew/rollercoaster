#!/usr/bin/env bash
# Single quality gate: typecheck, unit + integration tests with the coverage
# threshold, production build, UI observer tests and demo inline-script syntax.
# Prints one line per step (plus the tail of a failing step's log) and exits
# non-zero if any step fails. Logs go to VERIFY_LOG_DIR or a temp directory.
set -u
cd "$(dirname "$0")/.."

LOG_DIR="${VERIFY_LOG_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/rollercoaster-verify.XXXXXX")}"
mkdir -p "$LOG_DIR"
status=0

run() {
  local name="$1"
  shift
  if "$@" >"$LOG_DIR/$name.log" 2>&1; then
    printf 'PASS %s\n' "$name"
  else
    printf 'FAIL %s (log: %s/%s.log)\n' "$name" "$LOG_DIR" "$name"
    tail -n 30 "$LOG_DIR/$name.log" | sed 's/^/  | /'
    status=1
  fi
}

demo_syntax() {
  node - <<'JS'
const fs = require('fs');
const vm = require('vm');
const html = fs.readFileSync('public/demo/index.html', 'utf8');
const scripts = [...html.matchAll(/<script(\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
  .filter((match) => !(match[1] && /\bsrc=/.test(match[1])));
scripts.forEach((match, index) => new vm.Script(match[2], { filename: `inline-${index}` }));
new vm.Script(fs.readFileSync('public/demo/ride-observer.js', 'utf8'), { filename: 'ride-observer.js' });
console.log(`${scripts.length} inline script(s) and ride-observer.js parse`);
JS
}

run typecheck npx tsc --noEmit -p tsconfig.json
run tests npx jest --coverage --silent --coverageReporters=text-summary --coverageDirectory="$LOG_DIR/coverage"
run build npm run build
run observer node --test tests/ui/ride-observer.test.cjs
run demo-syntax demo_syntax

grep -E '^(Tests:|Statements|Branches|Functions|Lines)' "$LOG_DIR/tests.log" | sed 's/^/  /'
echo "logs: $LOG_DIR"
exit "$status"
