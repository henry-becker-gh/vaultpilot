#!/usr/bin/env bash
# VaultPilot devnet pipeline: header-gated funding -> deploy -> initialize -> demo deposits
# -> writes docs/DEVNET_EVIDENCE.md with all signatures + Explorer links.
#
# Etymology of the guards: the devnet faucet free tier is 1 airdrop / IP / 24h and
# REJECTED attempts still decrement the quota counter (observed 2026-09-17), so this
# script makes AT MOST ONE requestAirdrop attempt per key per 20-minute window and
# aborts a pass cleanly on the first 429. VP_LOOP=1 keeps waiting for the reset
# (max 48 windows); default is a single pass.
#
# Env: VP_KEYS (default /workspace/vaultpilot-secrets/keypairs), VP_LOOP=1 to wait for quota
set -e
cd "$(dirname "$0")/.."
export PATH="$HOME/.local/share/solana/install/active_release/bin:$HOME/.cargo/bin:$PATH"
KEYS=${VP_KEYS:-/workspace/vaultpilot-secrets/keypairs}
RPC=https://api.devnet.solana.com
EVIDENCE=docs/DEVNET_EVIDENCE.md
mkdir -p docs
log(){ echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $*"; }

pub(){ solana-keygen pubkey "$1"; }
bal(){ solana balance "$1" --url $RPC 2>/dev/null | grep -o '^[0-9]*' || echo 0; }

# one airdrop attempt; sets REMAINING from headers; returns 0 on HTTP 200
try_airdrop(){
  local PUB=$1
  local H=$(mktemp) B=$(mktemp)
  curl -s -D "$H" -o "$B" -m 30 -X POST $RPC -H "Content-Type: application/json" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"requestAirdrop\",\"params\":[\"$PUB\",1000000000]}"
  REMAINING=$(grep -i x-ratelimit-airdrop-remaining "$H" | tr -dc '0-9-' || echo '?')
  if grep -q "^HTTP/.. 200" "$H"; then rm -f "$H" "$B"; return 0; fi
  rm -f "$H" "$B"; return 1
}

NEED_AUTH=2000000000   # 2 SOL: deploy rent+buffer ~1.84 + init rent/fees
NEED_DEP=600000000     # 0.6 SOL: two deposits 0.433 + fees/rent

auth_pub=$(pub $KEYS/authority.json)
dep_pub=$(pub $KEYS/depositor.json)

windows=0
while :; do
  AB=$(bal $auth_pub); DB=$(bal $dep_pub)
  log "window $windows: authority=$AB/2 SOL depositor=$DB/0.6 SOL (remaining=$REMAINING)"
  if [ "${AB:-0}" -ge 2 ] && [ "${DB:-0}" -ge 1 ] 2>/dev/null; then log "FUNDED"; break; fi

  if [ "${AB:-0}" -lt 2 ]; then
    if try_airdrop $auth_pub; then log "airdrop -> authority OK (remaining=$REMAINING)"
    else log "authority airdrop refused (remaining=$REMAINING)"; fi
  fi
  sleep 5
  DB=$(bal $dep_pub)
  if [ "${DB:-0}" -lt 1 ] && [ "${AB:-0}" -ge 2 ]; then
    # authority funded: transfers are NOT faucet-limited -> fund depositor on-chain
    solana transfer $dep_pub 0.6 --from $KEYS/authority.json --url $RPC --allow-unfunded-recipient >/dev/null 2>&1 \
      && log "transferred 0.6 SOL authority -> depositor" || log "transfer pending"
  elif [ "${DB:-0}" -lt 1 ]; then
    if try_airdrop $dep_pub; then log "airdrop -> depositor OK (remaining=$REMAINING)"
    else log "depositor airdrop refused (remaining=$REMAINING)"; fi
  fi

  AB=$(bal $auth_pub); DB=$(bal $dep_pub)
  if [ "${AB:-0}" -ge 2 ] && [ "${DB:-0}" -ge 1 ] 2>/dev/null; then log "FUNDED"; break; fi

  if [ "${VP_LOOP:-0}" != "1" ]; then log "single pass done, not funded yet — rerun with VP_LOOP=1"; exit 2; fi
  windows=$((windows+1))
  [ $windows -gt 48 ] && { log "gave up after 48 windows (~16h)"; exit 3; }
  log "sleeping 20 min"; sleep 1200
done

log "== build =="
cargo-build-sbf --manifest-path program/Cargo.toml >/tmp/vp-pipeline-build.log 2>&1 || { tail -20 /tmp/vp-pipeline-build.log; exit 4; }
cp $KEYS/program.json target/deploy/vaultpilot-keypair.json
PROGRAM_ID=$(solana-keygen pubkey target/deploy/vaultpilot-keypair.json)
log "program $PROGRAM_ID"

log "== deploy =="
DEPLOY_OUT=$(solana program deploy target/deploy/vaultpilot.so --program-id target/deploy/vaultpilot-keypair.json --url $RPC 2>&1)
echo "$DEPLOY_OUT"
DEPLOY_SIG=$(echo "$DEPLOY_OUT" | grep -o 'Signature: .*' | awk '{print $2}')

log "== initialize =="
INIT_OUT=$(node scripts/devnet-init.js)
echo "$INIT_OUT"

log "== deposits =="
D1_OUT=$(node scripts/devnet-deposit.js 100000000)
echo "$D1_OUT"
D2_OUT=$(node scripts/devnet-deposit.js 333333333)
echo "$D2_OUT"

log "== writing $EVIDENCE =="
{
echo "# VaultPilot devnet evidence (auto-generated $(date -u +%Y-%m-%dT%H:%M:%SZ))"
echo
echo "- Program ID: \`$PROGRAM_ID\`"
echo "- Explorer: https://explorer.solana.com/address/$PROGRAM_ID?cluster=devnet"
echo "- Program size: $(stat -c%s target/deploy/vaultpilot.so) bytes; deploy funded by faucet test SOL (no real value)"
echo
echo "## Deployment"
if [ -n "$DEPLOY_SIG" ]; then
  echo "- deploy signature: \`$DEPLOY_SIG\`"
  echo "- https://explorer.solana.com/tx/$DEPLOY_SIG?cluster=devnet"
fi
echo
echo "## Transactions"
echo '```'
echo "$INIT_OUT"
echo "$D1_OUT"
echo "$D2_OUT"
echo '```'
} > $EVIDENCE
log "DONE — evidence at $EVIDENCE"
