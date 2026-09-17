/**
 * VaultPilot client library — instruction builders, PDA derivation, decoders.
 * Wire format is defined in program/src/lib.rs (vanilla Rust, no Anchor IDL).
 */
const {
  PublicKey, TransactionInstruction, Transaction, SystemProgram,
} = require('@solana/web3.js');

const PROGRAM_ID = new PublicKey('AWdkgjxyu5hV45FXGpw15NMS4fee55CVfdCaUPLHicCw');

const SEED_VAULT = Buffer.from('vault');
const SEED_POLICY = Buffer.from('policy');
const SEED_OPERATING = Buffer.from('operating');
const SEED_RESERVE = Buffer.from('reserve');
const SEED_TREASURY = Buffer.from('treasury');
const SEED_SPLIT = Buffer.from('split');

const ERRORS = {
  1: 'BadSplitSum', 2: 'EmptyShare', 3: 'BadName', 4: 'BadVault',
  5: 'BadPolicy', 6: 'BadShareAccount', 7: 'BadSplitRecord',
  8: 'Uninitialized', 9: 'Overflow', 10: 'BadIndex',
};

function vaultPda(authority) {
  return PublicKey.findProgramAddressSync([SEED_VAULT, authority.toBuffer()], PROGRAM_ID)[0];
}
function policyPda(authority) {
  return PublicKey.findProgramAddressSync([SEED_POLICY, authority.toBuffer()], PROGRAM_ID)[0];
}
function sharePda(seed, authority) {
  return PublicKey.findProgramAddressSync([seed, authority.toBuffer()], PROGRAM_ID)[0];
}
function splitRecordPda(vault, index) {
  const idx = Buffer.alloc(8);
  idx.writeBigUInt64LE(BigInt(index));
  return PublicKey.findProgramAddressSync([SEED_SPLIT, vault.toBuffer(), idx], PROGRAM_ID)[0];
}

/** instruction 0: initialize(authority, share_bps[3], name) */
function initializeInstruction({ authority, shareBps, name }) {
  const nameBytes = Buffer.from(name, 'utf8');
  if (nameBytes.length > 32) throw new Error('name too long (max 32 bytes)');
  const data = Buffer.alloc(1 + 32 + 6 + 1 + nameBytes.length);
  let o = 0;
  data.writeUInt8(0, o); o += 1;
  authority.toBuffer().copy(data, o); o += 32;
  for (const bps of shareBps) { data.writeUInt16LE(bps, o); o += 2; }
  data.writeUInt8(nameBytes.length, o); o += 1;
  nameBytes.copy(data, o);
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: authority, isSigner: true, isWritable: true },   // payer == authority
      { pubkey: vaultPda(authority), isSigner: false, isWritable: true },
      { pubkey: policyPda(authority), isSigner: false, isWritable: true },
      { pubkey: sharePda(SEED_OPERATING, authority), isSigner: false, isWritable: true },
      { pubkey: sharePda(SEED_RESERVE, authority), isSigner: false, isWritable: true },
      { pubkey: sharePda(SEED_TREASURY, authority), isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

/** instruction 1: deposit_and_split(amount) — index = policy.deposit_count */
async function depositInstruction(connection, { depositor, authority, amount, index }) {
  const vault = vaultPda(authority);
  let idx = index;
  if (idx === undefined) {
    const pol = await getPolicy(connection, authority);
    idx = pol ? pol.depositCount : 0;
  }
  const record = splitRecordPda(vault, idx);
  const data = Buffer.alloc(9);
  data.writeUInt8(1, 0);
  data.writeBigUInt64LE(BigInt(amount), 1);
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: depositor, isSigner: true, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: policyPda(authority), isSigner: false, isWritable: true },
      { pubkey: sharePda(SEED_OPERATING, authority), isSigner: false, isWritable: true },
      { pubkey: sharePda(SEED_RESERVE, authority), isSigner: false, isWritable: true },
      { pubkey: sharePda(SEED_TREASURY, authority), isSigner: false, isWritable: true },
      { pubkey: record, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

/** decode Policy borsh struct */
function decodePolicy(data) {
  let o = 0;
  const authority = new PublicKey(data.slice(o, o + 32)); o += 32;
  const bump = data.readUInt8(o); o += 1;
  const vaultBump = data.readUInt8(o); o += 1;
  const shareBps = [data.readUInt16LE(o), data.readUInt16LE(o + 2), data.readUInt16LE(o + 4)]; o += 6;
  const nameLen = data.readUInt32LE(o); o += 4;
  const name = data.slice(o, o + nameLen).toString('utf8'); o += nameLen;
  const createdAt = Number(data.readBigInt64LE(o)); o += 8;
  const depositCount = Number(data.readBigUInt64LE(o)); o += 8;
  const totalDeposited = Number(data.readBigUInt64LE(o)); o += 8;
  const totalOperating = Number(data.readBigUInt64LE(o)); o += 8;
  const totalReserve = Number(data.readBigUInt64LE(o)); o += 8;
  const totalTreasury = Number(data.readBigUInt64LE(o)); o += 8;
  return { authority, bump, vaultBump, shareBps, name, createdAt, depositCount,
    totalDeposited, totalOperating, totalReserve, totalTreasury };
}

/** decode SplitRecord borsh struct */
function decodeSplitRecord(data) {
  let o = 0;
  const vault = new PublicKey(data.slice(o, o + 32)); o += 32;
  const index = Number(data.readBigUInt64LE(o)); o += 8;
  const depositor = new PublicKey(data.slice(o, o + 32)); o += 32;
  const amount = Number(data.readBigUInt64LE(o)); o += 8;
  const splits = [Number(data.readBigUInt64LE(o)), Number(data.readBigUInt64LE(o + 8)), Number(data.readBigUInt64LE(o + 16))]; o += 24;
  const slot = Number(data.readBigUInt64LE(o)); o += 8;
  const timestamp = Number(data.readBigInt64LE(o)); o += 8;
  return { vault, index, depositor, amount, splits, slot, timestamp };
}

async function getPolicy(connection, authority) {
  const info = await connection.getAccountInfo(policyPda(authority));
  return info ? decodePolicy(info.data) : null;
}
async function getSplitRecord(connection, authority, index) {
  const info = await connection.getAccountInfo(splitRecordPda(vaultPda(authority), index));
  return info ? decodeSplitRecord(info.data) : null;
}

/** send + confirm a tx from one signer; returns signature */
async function signSendConfirm(connection, ixers, signers, label) {
  const tx = new Transaction();
  for (const ix of ixers) tx.add(ix);
  const sig = await connection.sendTransaction(tx, signers);
  const latest = await connection.getLatestBlockhash();
  await connection.confirmTransaction({ signature: sig, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight }, 'confirmed');
  if (label) console.log(`    tx [${label}]: ${sig}`);
  return sig;
}

/** extract the 3x u64 LE program return data [operating, reserve, treasury] */
async function getReturnSplits(connection, sig) {
  const tx = await connection.getTransaction(sig, { maxSupportedTransactionVersion: 0 });
  if (!tx || !tx.meta || !tx.meta.returnData) return null;
  const [b64] = tx.meta.returnData.data;
  const buf = Buffer.from(b64, 'base64');
  return [Number(buf.readBigUInt64LE(0)), Number(buf.readBigUInt64LE(8)), Number(buf.readBigUInt64LE(16))];
}

/** get log messages of a confirmed tx */
async function getLogs(connection, sig) {
  const tx = await connection.getTransaction(sig, { maxSupportedTransactionVersion: 0 });
  return (tx && tx.meta && tx.meta.logMessages) ? tx.meta.logMessages : [];
}

/** extract VAULTPILOT_EVENT json objects from logs */
function parseEvents(logs) {
  const out = [];
  for (const line of logs) {
    const m = line.match(/VAULTPILOT_EVENT (\{.*\})/);
    if (m) { try { out.push(JSON.parse(m[1])); } catch (_) { /* ignore */ } }
  }
  return out;
}

module.exports = {
  PROGRAM_ID, SEED_VAULT, SEED_POLICY, SEED_OPERATING, SEED_RESERVE, SEED_TREASURY, SEED_SPLIT,
  ERRORS, vaultPda, policyPda, sharePda, splitRecordPda,
  initializeInstruction, depositInstruction,
  decodePolicy, decodeSplitRecord, getPolicy, getSplitRecord,
  signSendConfirm, getReturnSplits, getLogs, parseEvents,
};
