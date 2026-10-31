#!/usr/bin/env bash
# Installs the dependencies in lib/ (no git submodules: the project is not in a repository yet).
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p lib
[ -d lib/forge-std ] || git clone -q --depth 1 --branch v1.17.0 https://github.com/foundry-rs/forge-std lib/forge-std
if [ ! -d lib/aave-v3-origin ]; then
  git clone -q https://github.com/aave-dao/aave-v3-origin lib/aave-v3-origin
  git -C lib/aave-v3-origin checkout -q 8305565ae342f1773c42cd2e4593f175fe5968a0   # v3.6, tested
  git -C lib/aave-v3-origin submodule update -q --init --recursive --depth 1
fi
echo "ok: forge test"
