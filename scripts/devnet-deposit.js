/**
 * Devnet driver: one deposit_and_split from the depositor keypair file.
 * Usage: node scripts/devnet-deposit.js <lamports>
 * Env: VP_KEYS, VP_RPC
 */
const fs = require('fs');
const path = require('path');
const { Connection, Keypair, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const C = require('../client');

const KEYS = process.env.VP_KEYS || '/workspace/vaultpilot-secrets/keypairs';
const RPC = process.env.VP_RPC || 'https://api.devnet.solana.com';
const load = (f) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(KEYS, f), 'utf8'))));

(async () => {
  const amount = parseInt(process.argv[2] || '100000000', 10);
  const connection = new Connection(RPC, 'confirmed');
  const depositor = load('depositor.json');
  const authority = load('authority.json');
  const bal = await connection.getBalance(depositor.publicKey);
  console.log('depositor', depositor.publicKey.toBase58(), 'balance', bal / LAMPORTS_PER_SOL, 'SOL; depositing', amount, 'lamports');
  if (bal < amount + 100000) throw new Error('depositor not funded enough');
  const pol = await C.getPolicy(connection, authority.publicKey);
  if (!pol) throw new Error('vault not initialized');
  const ix = await C.depositInstruction(connection, { depositor: depositor.publicKey, authority: authority.publicKey, amount, index: pol.depositCount });
  const sig = await C.signSendConfirm(connection, [ix], [depositor], `deposit#${pol.depositCount}(devnet)`);
  const ret = await C.getReturnSplits(connection, sig);
  const rec = await C.getSplitRecord(connection, authority.publicKey, pol.depositCount);
  console.log('split ->', JSON.stringify(ret), '| record PDA:', C.splitRecordPda(C.vaultPda(authority.publicKey), pol.depositCount).toBase58());
  console.log('record decoded:', JSON.stringify({ ...rec, vault: rec.vault.toBase58(), depositor: rec.depositor.toBase58() }));
  console.log('tx:', `https://explorer.solana.com/tx/${sig}?cluster=devnet`);
})();
