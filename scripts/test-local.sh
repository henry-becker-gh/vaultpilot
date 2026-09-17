#!/usr/bin/env bash
# Build the program, start a local test-validator, run the integration suite.
# NOTE: uses whatever solana-test-validator is on PATH. Agave 4.x test-validator
# requires io_uring; in restricted containers install v2.1.x:
#   curl -sSfL https://release.anza.xyz/v2.1.21/install | sh
set -e
cd "$(dirname "$0")/.."
export PATH="$HOME/.local/share/solana/install/active_release/bin:$HOME/.cargo/bin:$PATH"

echo "== cargo-build-sbf =="
cargo-build-sbf --manifest-path program/Cargo.toml >/tmp/vp-build.log 2>&1 || { tail -30 /tmp/vp-build.log; exit 1; }
tail -2 /tmp/vp-build.log
# keep OUR program keypair so the on-chain address matches declare_id!
cp /workspace/vaultpilot-secrets/keypairs/program.json target/deploy/vaultpilot-keypair.json 2>/dev/null || true

echo "== start local validator =="
pkill -f solana-test-validator 2>/dev/null || true
sleep 1
rm -rf /tmp/vp-test-ledger
solana-test-validator --bpf-program AWdkgjxyu5hV45FXGpw15NMS4fee55CVfdCaUPLHicCw \
  target/deploy/vaultpilot.so --reset --quiet --ledger /tmp/vp-test-ledger \
  > /tmp/vp-validator.log 2>&1 &
for i in $(seq 1 40); do
  sleep 3
  solana cluster-version --url http://127.0.0.1:8899 >/dev/null 2>&1 && break
done
solana cluster-version --url http://127.0.0.1:8899 || { echo "validator did not start; log:"; tail -20 /tmp/vp-validator.log; exit 1; }

echo "== integration tests =="
node test/e2e-local.js
