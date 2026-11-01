#!/usr/bin/env bash
# Fetches a real KyberSwap quote on Base, USDC -> WETH, with the fork executor as sender and recipient,
# and prints the env vars expected by test_fork_open_aggregatorCalldata (see quote-velora.sh).
#
#   eval "$(script/quote-kyber.sh 2000)"
#   BASE_RPC_URL=... forge test --match-test test_fork_open_aggregatorCalldata -vv
set -euo pipefail

USDC_AMOUNT=${1:-2000}
SLIPPAGE_BPS=${SLIPPAGE_BPS:-50}
USDC=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
WETH=0x4200000000000000000000000000000000000006
EXECUTOR=0x58855651bf7393c4ba9749C6Ca1dc2be019Cba71
API=https://aggregator-api.kyberswap.com/base/api/v1
AMOUNT=$((USDC_AMOUNT * 1000000))

ROUTES=$(curl -fsS -H 'x-client-id: auto-loop' "$API/routes?tokenIn=$USDC&tokenOut=$WETH&amountIn=$AMOUNT")
SUMMARY=$(echo "$ROUTES" | jq -c '.data.routeSummary')
if [ -n "$(echo "$SUMMARY" | jq -r '.extraFee.feeAmount // ""')" ] && [ "$(echo "$SUMMARY" | jq -r '.extraFee.feeAmount')" != "0" ]; then
  echo "quote carries a fee, refusing" >&2; exit 1
fi
BODY=$(jq -cn --argjson s "$SUMMARY" --arg u "$EXECUTOR" --argjson slip "$SLIPPAGE_BPS" \
  '{routeSummary:$s, sender:$u, recipient:$u, slippageTolerance:$slip, skipSimulateTx:true, source:"auto-loop"}')
TX=$(curl -fsS -X POST -H 'content-type: application/json' -H 'x-client-id: auto-loop' "$API/route/build" -d "$BODY")
OUT=$(echo "$TX" | jq -r '.data.amountOut')
MIN_OUT=$(python3 -c "print($OUT * (10000 - $SLIPPAGE_BPS) // 10000)")

echo "export AGG_ROUTER=$(echo "$TX" | jq -r '.data.routerAddress')"
echo "export AGG_DATA=$(echo "$TX" | jq -r '.data.data')"
echo "export AGG_SELL_AMOUNT=$AMOUNT"
echo "export AGG_MIN_OUT=$MIN_OUT"
