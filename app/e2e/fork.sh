#!/usr/bin/env bash
# (Re)forks Base at the latest block in a running anvil, deploys LeverageExecutor with Velora's and KyberSwap's
# routers whitelisted (fixed for good: the contract has no owner), and gives the test user (anvil account 1) 1.5 WETH.
#   anvil --fork-url https://mainnet.base.org --chain-id 8453   # once, in another terminal
#   bash e2e/fork.sh                                            # before each run: the fork must be fresh
# NO_DEPLOY=1 skips the deployment (to test the app's own "Déployer le contrat" button).
# Optional: SOLC=/path/to/solc-0.8.27 when forge cannot download solc.
set -euo pipefail
R=${RPC:-http://127.0.0.1:8545}
U=0x70997970C51812dc3A010C7d01b50e0d17dc79C8
DEPLOYER_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 # anvil account 0, public test key
cast rpc --rpc-url $R anvil_reset '{"forking":{"jsonRpcUrl":"https://mainnet.base.org"}}' >/dev/null
cd "$(dirname "$0")/../../contracts"
if [ -n "${NO_DEPLOY:-}" ]; then cd - >/dev/null; else
# same deployer, same nonce after each reset: the address stays 0x33dd750d10F53475A1FbF5e079a02BF0F74C3646
forge create ${SOLC:+--use $SOLC} --broadcast --rpc-url $R --private-key $DEPLOYER_KEY \
  src/LeverageExecutor.sol:LeverageExecutor \
  --constructor-args 0xA238Dd80C259a72e81d7e4664a9801593F98d1c5 "[0x6A000F20005980200259B80c5102003040001068,0x6131B5fae19EA4f9D964eAc0408E4408b66337b5]" | grep Deployed
fi
cast send --rpc-url $R --unlocked --from $U 0x4200000000000000000000000000000000000006 "deposit()" --value 1.5ether >/dev/null
echo "fork block $(cast block-number --rpc-url $R), user $U: 1.5 WETH"
