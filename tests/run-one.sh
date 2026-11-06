#!/bin/bash
# Runs ONE end-to-end suite on the Whitechain testnet with a fresh database:  tests/run-one.sh core|extensions|saas|accounts|cli-mcp|web
# Starts the stack (API :3000 + web :3001), waits until it is synced with the chain, runs the suite, stops the stack.
cd "$(dirname "$0")/.." || exit 1
[ -f "tests/e2e/$1.js" ] || { echo "usage: tests/run-one.sh <suite>   (one of: $(ls tests/e2e | sed 's/\.js//' | tr '\n' ' '))"; exit 1; }
LOG=/tmp/whitepay-tests; mkdir -p $LOG
stop() { pkill -f "server/index.js" 2>/dev/null; pkill -f "next-server" 2>/dev/null; pkill -f "next start" 2>/dev/null; pkill -f "scripts/testnet.js" 2>/dev/null; sleep 2; }
trap stop EXIT
stop; rm -f data-testnet/whitepay.db
[ -d web/.next ] || (cd web && npx next build > $LOG/web-build.log 2>&1)
(nohup node scripts/testnet.js --prod > $LOG/stack.log 2>&1 < /dev/null &)
for i in $(seq 1 90); do
  curl -sf localhost:3000/api/status 2>/dev/null | grep -q '"rpcOk":true' && curl -sf -o /dev/null localhost:3001/pricing && break
  sleep 2
done
node "tests/e2e/$1.js"
