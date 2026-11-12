#!/usr/bin/env bash
# Publishes the source of a deployed Auto-loop executor on Sourcify, so that explorers that read it (Blockscout,
# Routescan…) and wallets (Rabby) show the contract's name and decode its calls instead of an unknown address.
# Run after a real deployment (from the app's button), from contracts/ with the same build as the app's bytecode:
#   CHAIN=9745 ADDRESS=0x… bash script/verify-sourcify.sh                      # LeverageExecutorV2
#   CHAIN=1 ADDRESS=0x… CONTRACT=morpho bash script/verify-sourcify.sh         # LeverageExecutorMorpho
# Optional: SOLC=/path/to/solc-0.8.27 when forge cannot download solc. Sourcify takes the constructor arguments from
# the creation transaction (a CREATE2 deployment through 0x4e59…956C included). Not run yet: no real deployment so far.
set -euo pipefail
: "${CHAIN:?chain id}" "${ADDRESS:?deployed address}"
case "${CONTRACT:-v2}" in
  v2) TARGET=src/LeverageExecutorV2.sol:LeverageExecutorV2 ;;
  morpho) TARGET=src/LeverageExecutorMorpho.sol:LeverageExecutorMorpho ;;
  v1) TARGET=src/LeverageExecutor.sol:LeverageExecutor ;;
  *) echo "CONTRACT = v2, morpho or v1" >&2; exit 1 ;;
esac
cd "$(dirname "$0")/.."
forge build ${SOLC:+--use $SOLC} >/dev/null
forge verify-contract "$ADDRESS" "$TARGET" --chain-id "$CHAIN" --verifier sourcify ${SOLC:+--use $SOLC} --watch
