#!/bin/bash
# Runs every automated check against the Whitechain TESTNET (chain 1874). Nothing runs on a local chain.
#   tests/run-all.sh                 everything
#   tests/run-all.sh --redeploy      deploy fresh contracts first (a clean on-chain slate; costs a little testnet WBT)
# Needs: Node 24, `npm run web:install` once, .env.testnet (see .env.example) with a funded DEPLOYER_KEY.
# Contract rules that depend on long timers (30-day periods, timelocks) are checked by the in-memory contract tests, which never touch a chain.
# Every end-to-end suite starts the stack (API :3000 + web :3001) with an empty database and uses short on-chain timers.
cd "$(dirname "$0")/.." || exit 1
LOG=/tmp/whitepay-tests; mkdir -p $LOG
fails=0
stop() { pkill -f "server/index.js" 2>/dev/null; pkill -f "next-server" 2>/dev/null; pkill -f "next start" 2>/dev/null; pkill -f "next dev" 2>/dev/null; pkill -f "scripts/testnet.js" 2>/dev/null; sleep 2; }
fresh() { # empty database, fresh processes; wait until the API has synced with the chain and the web app answers
  stop; rm -f data-testnet/whitepay.db
  (nohup node scripts/testnet.js --prod > $LOG/stack.log 2>&1 < /dev/null &)
  for i in $(seq 1 90); do
    if curl -sf localhost:3000/api/status 2>/dev/null | grep -q '"rpcOk":true' && curl -sf -o /dev/null localhost:3001/pricing; then return 0; fi
    sleep 2
  done
  echo "stack did not become ready (see $LOG/stack.log)"; return 1
}
stage() { local name=$1; shift
  if "$@" > "$LOG/$name.log" 2>&1; then echo "PASS  $name"; else echo "FAIL  $name   (see $LOG/$name.log)"; fails=$((fails+1)); fi
}
trap stop EXIT
set -a; . ./.env.testnet 2>/dev/null; set +a   # API_KEY etc. for the SDK tests

echo "== network: $(node -e 'const d=require("./data-testnet/deployment.json");console.log(d.network, "chain", d.chainId, d.pay)')"
if [ "$1" = "--redeploy" ]; then stage redeploy npm run deploy:testnet; fi
echo "== static"
stage web-typecheck bash -c "cd web && npx tsc --noEmit"
stage i18n          node tests/checks/i18n.js
echo "== contract rules (in-memory, no chain)"
stage contracts     npx hardhat test
echo "== web app build"
stage web-build     bash -c "cd web && npx next build"
echo "== end to end on the testnet (fresh database each)"
fresh && stage core        node tests/e2e/core.js
fresh && stage extensions  node tests/e2e/extensions.js
fresh && stage saas        node tests/e2e/saas.js
fresh && stage accounts    node tests/e2e/accounts.js
fresh && stage cli-mcp     node tests/e2e/cli-mcp.js
stage openapi       node tests/checks/openapi.js
stage notify        node tests/e2e/notify.js
fresh && stage web         node tests/e2e/web.js
echo "== SDKs (live API tests)"
fresh && stage sdks        env WHITEPAY_BASE_URL=http://localhost:3000/api/v1 WHITEPAY_API_KEY="$API_KEY" sdks/test-all.sh
stage sweep-wallets node tests/support/sweep.js
echo
[ $fails -eq 0 ] && echo "ALL PASSED" || { echo "$fails stage(s) FAILED"; exit 1; }
