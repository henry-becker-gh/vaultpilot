/**
 * Devnet driver: initialize the vault from the authority keypair file.
 * Env: VP_KEYS (default /workspace/vaultpilot-secrets/keypairs), VP_RPC (default devnet)
 */
const fs = require('fs');
const path = require('path');
const { Connection, Keypair, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const C = require('../client');

const KEYS = process.env.VP_KEYS || '/workspace/vaultpilot-secrets/keypairs';
const RPC = process.env.VP_RPC || 'https://api.devnet.solana.com';
const load = (f) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(KEYS, f), 'utf8'))));

(async () => {
  const connection = new Connection(RPC, 'confirmed');
  const authority = load('authority.json');
  const shareBps = [7000, 2000, 1000];
  const existing = await C.getPolicy(connection, authority.publicKey);
  if (existing) {
    console.log('policy already initialized:', JSON.stringify({
      authority: authority.publicKey.toBase58(), shareBps: existing.shareBps, deposits: existing.depositCount,
    }));
    return;
  }
  const bal = await connection.getBalance(authority.publicKey);
  console.log('authority', authority.publicKey.toBase58(), 'balance', bal / LAMPORTS_PER_SOL, 'SOL');
  if (bal < 1e7) throw new Error('authority not funded — run scripts/devnet-demo.sh step 2 first');
  const ix = C.initializeInstruction({ authority: authority.publicKey, shareBps, name: 'VaultPilot Demo' });
  const sig = await C.signSendConfirm(connection, [ix], [authority], 'initialize(devnet)');
  console.log('INITIALIZED. tx:', `https://explorer.solana.com/tx/${sig}?cluster=devnet`);
  console.log('vault :', C.vaultPda(authority.publicKey).toBase58());
  console.log('policy:', C.policyPda(authority.publicKey).toBase58());
})();
