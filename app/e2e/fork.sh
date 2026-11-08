#!/usr/bin/env bash
# (Re)forks Base at the latest block in a running anvil, deploys LeverageExecutorV2 with Velora's and KyberSwap's
# routers whitelisted and Morpho Blue as free flash lender (fixed for good: the contract has no owner), and gives the
# test user (anvil account 1) 1.5 WETH. V1=1 deploys the old LeverageExecutor instead (to test v1 executors).
#   anvil --fork-url https://mainnet.base.org --chain-id 8453   # once, in another terminal
#   bash e2e/fork.sh                                            # before each run: the fork must be fresh
# NO_DEPLOY=1 skips the deployment (to test the app's own "Déployer le contrat" button).
# NET=ethereum forks Ethereum instead (anvil started with --chain-id 1): the executor also whitelists Pendle's router,
# live Pendle PTs are listed on Aave Core (contracts/script/ForkListPt.s.sol, SPLIT=1 for separate eModes) and the
# user gets 1 ETH, 20 000 USDC and 5000 USDe.
# Optional: SOLC=/path/to/solc-0.8.27 when forge cannot download solc.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
R=${RPC:-http://127.0.0.1:8545}
U=0x70997970C51812dc3A010C7d01b50e0d17dc79C8
DEPLOYER_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 # anvil account 0, public test key
if [ "${NET:-base}" = ethereum ]; then
  POOL=0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2
  ROUTERS="[0x6A000F20005980200259B80c5102003040001068,0x6131B5fae19EA4f9D964eAc0408E4408b66337b5,0x888888888889758F76e7103c6CbF23ABbF58F946]"
  DEFAULT_FORK=https://ethereum-rpc.publicnode.com
else
  POOL=0xA238Dd80C259a72e81d7e4664a9801593F98d1c5
  ROUTERS="[0x6A000F20005980200259B80c5102003040001068,0x6131B5fae19EA4f9D964eAc0408E4408b66337b5]"
  DEFAULT_FORK=https://mainnet.base.org
fi
cast rpc --rpc-url $R anvil_reset "{\"forking\":{\"jsonRpcUrl\":\"${FORK_URL:-$DEFAULT_FORK}\"}}" >/dev/null
cd "$HERE/../../contracts"
if [ -n "${NO_DEPLOY:-}" ]; then cd - >/dev/null; else
# the address depends on the deployer's nonce at the fork block: pass the printed one to the app (VITE_EXECUTORS)
if [ -n "${V1:-}" ]; then
  forge create ${SOLC:+--use $SOLC} --broadcast --rpc-url $R --private-key $DEPLOYER_KEY \
    src/LeverageExecutor.sol:LeverageExecutor \
    --constructor-args $POOL "$ROUTERS" | grep Deployed
else
  # forge create does not take the lenders' tuple array: deploy the build output with cast
  forge build ${SOLC:+--use $SOLC} >/dev/null
  BYTECODE=$(jq -r .bytecode.object out/LeverageExecutorV2.sol/LeverageExecutorV2.json)
  ARGS=$(cast abi-encode "f(address,address[],(uint8,address)[])" $POOL "$ROUTERS" "[(1,0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb)]")
  echo "Deployed to: $(cast send --rpc-url $R --private-key $DEPLOYER_KEY --create "$BYTECODE${ARGS#0x}" --json | jq -r .contractAddress)"
fi
fi
if [ "${NET:-base}" = ethereum ]; then
  ADMIN=0x5300A1a15135EA4dc7aD5a167152C01EFc9b192A # Aave ACL admin (governance executor)
  cast rpc --rpc-url $R anvil_impersonateAccount $ADMIN >/dev/null
  cast rpc --rpc-url $R anvil_setBalance $ADMIN 0xDE0B6B3A7640000 >/dev/null
  (cd "$HERE/../../contracts" && forge script script/ForkListPt.s.sol --tc ForkListPt ${SOLC:+--use $SOLC} --rpc-url $R --unlocked --sender $ADMIN --broadcast | grep eMode)
  for T in 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48:20000000000 0x4c9EDD5852cd905f086C759E8383e09bff1E68B3:5000000000000000000000; do
    A=$(cast call --rpc-url $R $POOL "getReserveAToken(address)(address)" ${T%%:*})
    cast rpc --rpc-url $R anvil_impersonateAccount $A >/dev/null
    cast rpc --rpc-url $R anvil_setBalance $A 0xDE0B6B3A7640000 >/dev/null
    cast send --rpc-url $R --unlocked --from $A ${T%%:*} "transfer(address,uint256)" $U ${T##*:} >/dev/null
  done
  echo "fork block $(cast block-number --rpc-url $R), user $U: 20 000 USDC, 5000 USDe"
  exit 0
fi
cast send --rpc-url $R --unlocked --from $U 0x4200000000000000000000000000000000000006 "deposit()" --value 1.5ether >/dev/null
# FUND=1: also 5000 USDC and 1 wstETH, taken from their Aave aToken contracts (they hold the underlying)
if [ -n "${FUND:-}" ]; then
  for T in 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913:5000000000 0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452:1000000000000000000; do
    A=$(cast call --rpc-url $R $POOL "getReserveAToken(address)(address)" ${T%%:*})
    cast rpc --rpc-url $R anvil_impersonateAccount $A >/dev/null
    cast rpc --rpc-url $R anvil_setBalance $A 0xDE0B6B3A7640000 >/dev/null
    cast send --rpc-url $R --unlocked --from $A ${T%%:*} "transfer(address,uint256)" $U ${T##*:} >/dev/null
  done
fi
echo "fork block $(cast block-number --rpc-url $R), user $U: 1.5 WETH${FUND:+, 5000 USDC, 1 wstETH}"
