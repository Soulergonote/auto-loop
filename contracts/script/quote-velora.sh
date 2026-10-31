#!/usr/bin/env bash
# Fetches a real Velora (ParaSwap) v6.2 quote on Base, USDC -> WETH, with the fork executor as taker,
# and prints the env vars expected by test_fork_open_aggregatorCalldata.
#
#   eval "$(script/quote-velora.sh 2000)"   # sell 2000 USDC
#   BASE_RPC_URL=... forge test --match-test test_fork_open_aggregatorCalldata -vv
#
# The quote is only valid for a few blocks: run the test right after (fork at the latest block).
# Requires curl and jq. Velora's public API needs no key.
set -euo pipefail

USDC_AMOUNT=${1:-2000}
SLIPPAGE_BPS=${SLIPPAGE_BPS:-50}
CHAIN_ID=8453
USDC=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
WETH=0x4200000000000000000000000000000000000006
# address(uint160(uint256(keccak256("auto-loop.executor.fork")))), see test/fork/BaseFork.t.sol
EXECUTOR=0x58855651bf7393c4ba9749C6Ca1dc2be019Cba71
API=https://api.paraswap.io

AMOUNT=$((USDC_AMOUNT * 1000000))

PRICE=$(curl -fsS "$API/prices?srcToken=$USDC&srcDecimals=6&destToken=$WETH&destDecimals=18&amount=$AMOUNT&side=SELL&network=$CHAIN_ID&version=6.2&userAddress=$EXECUTOR")
ROUTE=$(echo "$PRICE" | jq -c '.priceRoute')
DEST=$(echo "$ROUTE" | jq -r '.destAmount')

BODY=$(jq -cn --argjson route "$ROUTE" --arg src "$USDC" --arg dst "$WETH" --arg amt "$AMOUNT" \
  --arg user "$EXECUTOR" --argjson slip "$SLIPPAGE_BPS" \
  '{srcToken:$src, destToken:$dst, srcAmount:$amt, srcDecimals:6, destDecimals:18, slippage:$slip, priceRoute:$route, userAddress:$user}')
TX=$(curl -fsS -X POST -H 'content-type: application/json' \
  "$API/transactions/$CHAIN_ID?ignoreChecks=true&ignoreGasEstimate=true" -d "$BODY")

MIN_OUT=$(python3 -c "print($DEST * (10000 - $SLIPPAGE_BPS) // 10000)")

echo "export AGG_ROUTER=$(echo "$TX" | jq -r '.to')"
echo "export AGG_DATA=$(echo "$TX" | jq -r '.data')"
echo "export AGG_SELL_AMOUNT=$AMOUNT"
echo "export AGG_MIN_OUT=$MIN_OUT"
