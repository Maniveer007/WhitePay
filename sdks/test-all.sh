#!/usr/bin/env bash
# Runs every SDK's tests: shared webhook vectors always, live API tests when WHITEPAY_BASE_URL is set.
# A language whose runtime isn't installed is reported as SKIPPED (never silently passed).
cd "$(dirname "$0")"
results=()
run() { # name, required-command, command...
  local name=$1 need=$2; shift 2
  if ! command -v "$need" >/dev/null 2>&1; then results+=("SKIPPED  $name ($need not installed)"); return; fi
  if (eval "$@") >/tmp/whitepay-sdk-$name.log 2>&1; then results+=("PASS     $name"); else results+=("FAIL     $name  (see /tmp/whitepay-sdk-$name.log)"); fi
}
run typescript node "cd typescript && node --test test/sdk.test.ts"
run python python3 "cd python && python3 -I tests/test_sdk.py"
run go go "cd go && go vet ./... && go test ./..."
run ruby ruby "cd ruby && ruby -Ilib test/test_whitepay.rb"
run java javac "cd java && rm -rf out && javac -Xlint:all -Werror --release 17 -d out \$(find src -name '*.java') && java -cp out io.whitepay.WhitePayTest"
run php php "cd php && php tests/run.php"
printf '%s\n' "${results[@]}"
! printf '%s\n' "${results[@]}" | grep -q '^FAIL'
