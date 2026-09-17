#!/usr/bin/env bash
# VaultPilot devnet end-to-end demo:
#   1) fund authority + depositor from the devnet faucet (test tokens only)
#   2) build + deploy the program (program ID from keypair, matches declare_id!)
#   3) initialize the vault (policy 70/20/10)
#   4) two deposit_and_split transactions
#   5) write docs/DEVNET_EVIDENCE.md with every signature + Explorer link
# All tokens used are devnet TEST tokens from the public faucet. No real value.
set -e
cd "$(dirname "$0")/.."
export PATH="$HOME/.local/share/solana/install/active_release/bin:$HOME/.cargo/bin:$PATH"
KEYS=${VP_KEYS:-/workspace/vaultpilot-secrets/keypairs}
RPC=https://api.devnet.solana.com
EVIDENCE=docs/DEVNET_EVIDENCE.md
mkdir -p docs

echo "== [1/5] faucet (retrying; devnet rate-limits by IP) =="
for f in authority depositor; do
  PUB=$(solana-keygen pubkey $KEYS/$f.json)
  BAL=$(solana balance $PUB --url $RPC | grep -o '^[0-9]*' || echo 0)
  if [ "$BAL" -lt 1 ] 2>/dev/null; then
    for i in 1 2 3 4 5 6 7 8; do
      solana airdrop 1 $PUB --url $RPC >/tmp/air.log 2>&1 && break
      echo "  airdrop attempt $i for $f failed: $(tail -1 /tmp/air.log)"
      sleep 20
    done
  fi
  echo "  $f: $PUB -> $(solana balance $PUB --url $RPC)"
done

echo "== [2/5] build + deploy =="
cargo-build-sbf --manifest-path program/Cargo.toml >/tmp/vp-build.log 2>&1 || { tail -20 /tmp/vp-build.log; exit 1; }
cp $KEYS/program.json target/deploy/vaultpilot-keypair.json
PROGRAM_ID=$(solana-keygen pubkey target/deploy/vaultpilot-keypair.json)
DEPLOY_OUT=$(solana program deploy target/deploy/vaultpilot.so --program-id target/deploy/vaultpilot-keypair.json --url $RPC 2>&1)
echo "$DEPLOY_OUT"
DEPLOY_SIG=$(echo "$DEPLOY_OUT" | grep -o 'Signature: .*' | awk '{print $2}' || true)

echo "== [3/5] initialize =="
INIT_OUT=$(node scripts/devnet-init.js)
echo "$INIT_OUT"

echo "== [4/5] deposits =="
D1_OUT=$(node scripts/devnet-deposit.js 100000000)   # 0.1 SOL
echo "$D1_OUT"
D2_OUT=$(node scripts/devnet-deposit.js 333333333)   # 0.333333333 SOL
echo "$D2_OUT"

echo "== [5/5] writing $EVIDENCE =="
{
echo "# VaultPilot devnet evidence (auto-generated $(date -u +%Y-%m-%dT%H:%M:%SZ))"
echo
echo "- Program ID: \`$PROGRAM_ID\`"
echo "- Explorer: https://explorer.solana.com/address/$PROGRAM_ID?cluster=devnet"
echo
echo "## Deployment"
echo "- deploy signature: \`${DEPLOY_SIG:-see output above}\`"
echo
echo "## Transactions"
echo '```'
echo "$INIT_OUT"
echo "$D1_OUT"
echo "$D2_OUT"
echo '```'
} > $EVIDENCE
echo "DONE. Evidence at $EVIDENCE"
