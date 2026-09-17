/**
 * VaultPilot end-to-end integration tests.
 * Runs against a local solana-test-validator with the program preloaded:
 *   solana-test-validator --bpf-program AWdkgjxyu5hV45FXGpw15NMS4fee55CVfdCaUPLHicCw target/deploy/vaultpilot.so
 * (see scripts/test-local.sh). Devnet variant: npm run test:devnet
 */
const assert = require('assert');
const {
  Connection, Keypair, LAMPORTS_PER_SOL, SystemProgram, Transaction, sendAndConfirmTransaction,
} = require('@solana/web3.js');
const C = require('../client');

const RPC = process.env.VP_RPC_URL || 'http://127.0.0.1:8899';
const connection = new Connection(RPC, 'confirmed');

let passed = 0, failed = 0;
function check(name, fn) {
  return fn().then(() => { passed++; console.log(`  PASS ${name}`); })
    .catch((e) => { failed++; console.log(`  FAIL ${name}\n    ${String(e.message || e).slice(0, 300)}`); });
}

async function airdrop(pk, sol) {
  for (let i = 0; i < 10; i++) {
    try {
      const sig = await connection.requestAirdrop(pk, sol * LAMPORTS_PER_SOL);
      const b = await connection.getBalance(pk);
      if (b > 0) return;
      await new Promise(r => setTimeout(r, 500));
    } catch (e) { await new Promise(r => setTimeout(r, 500)); }
  }
  throw new Error('airdrop failed after retries');
}

async function expectProgramError(label, buildTx, errCode, errName) {
  try {
    await buildTx();
    throw new Error(`${label}: expected tx to FAIL with custom error ${errCode} (${errName}) but it succeeded`);
  } catch (e) {
    const msg = String(e.message || e);
    if (msg.includes(`custom program error: 0x${errCode.toString(16)}`)) return;
    if (msg.includes('expected tx to FAIL')) throw e;
    throw new Error(`${label}: wrong failure, expected 0x${errCode.toString(16)} (${errName}), got: ${msg.slice(0, 200)}`);
  }
}

(async () => {
  console.log(`VaultPilot e2e against ${RPC}`);
  console.log(`program: ${C.PROGRAM_ID.toBase58()}`);

  const authority = Keypair.generate();
  const depositor = Keypair.generate();
  console.log(`authority: ${authority.publicKey.toBase58()}`);
  console.log(`depositor: ${depositor.publicKey.toBase58()}`);
  await airdrop(authority.publicKey, 10);
  await airdrop(depositor.publicKey, 5);

  const vault = C.vaultPda(authority.publicKey);
  const shares = {
    operating: C.sharePda(C.SEED_OPERATING, authority.publicKey),
    reserve: C.sharePda(C.SEED_RESERVE, authority.publicKey),
    treasury: C.sharePda(C.SEED_TREASURY, authority.publicKey),
  };
  console.log(`vault PDA: ${vault.toBase58()}  (derived from ["vault", authority])`);

  const bal = async (pk) => connection.getBalance(pk);
  const b0 = {
    dep: await bal(depositor.publicKey),
    vault: await bal(vault),
    op: await bal(shares.operating),
    res: await bal(shares.reserve),
    tre: await bal(shares.treasury),
  };

  // ---- T1: policy validation rejects a split that does not sum to 10000 ----
  await check('rejects share_bps summing to 9000 (custom error 0x1 BadSplitSum)', async () => {
    const ix = C.initializeInstruction({ authority: authority.publicKey, shareBps: [8000, 1000, 0], name: 'bad' });
    await expectProgramError('init',
      () => sendAndConfirmTransaction(connection, new Transaction().add(ix), [authority]),
      1, 'BadSplitSum');
  });

  // ---- T2: initialize with 70/20/10 ----
  await check('initialize creates vault+policy+shares with policy 7000/2000/1000', async () => {
    const ix = C.initializeInstruction({ authority: authority.publicKey, shareBps: [7000, 2000, 1000], name: 'VaultPilot Demo' });
    await C.signSendConfirm(connection, [ix], [authority], 'initialize');
    const pol = await C.getPolicy(connection, authority.publicKey);
    assert(pol, 'policy account missing');
    assert.strictEqual(pol.shareBps.join(','), '7000,2000,1000');
    assert.strictEqual(pol.name, 'VaultPilot Demo');
    assert.strictEqual(pol.depositCount, 0);
    assert.strictEqual(pol.authority.toBase58(), authority.publicKey.toBase58());
    assert((await bal(vault)) > 0, 'vault not rent-funded');
    assert((await bal(shares.operating)) > 0, 'operating share not rent-funded');
  });

  // baseline AFTER initialize: share accounts are rent-funded at creation, so
  // deposit assertions must measure the DELTA from here.
  const b1 = {
    vault: await bal(vault),
    op: await bal(shares.operating),
    res: await bal(shares.reserve),
    tre: await bal(shares.treasury),
  };

  // ---- T3: deposit 1.5 SOL -> 1.05 / 0.30 / 0.15 ----
  const DEPOSIT1 = 1_500_000_000;
  await check(`deposit_and_split ${DEPOSIT1} lamports -> 1050000000/300000000/150000000`, async () => {
    const ix = await C.depositInstruction(connection, { depositor: depositor.publicKey, authority: authority.publicKey, amount: DEPOSIT1 });
    const sig = await C.signSendConfirm(connection, [ix], [depositor], 'deposit#1');
    const ret = await C.getReturnSplits(connection, sig);
    assert.deepStrictEqual(ret, [1_050_000_000, 300_000_000, 150_000_000], `return data ${ret}`);
    assert.strictEqual(await bal(shares.operating), b1.op + 1_050_000_000);
    assert.strictEqual(await bal(shares.reserve), b1.res + 300_000_000);
    assert.strictEqual(await bal(shares.treasury), b1.tre + 150_000_000);
    assert.strictEqual(await bal(vault), b1.vault, 'vault must hold no residue');

    const rec = await C.getSplitRecord(connection, authority.publicKey, 0);
    assert(rec, 'split record #0 missing');
    assert.strictEqual(rec.index, 0);
    assert.strictEqual(rec.amount, DEPOSIT1);
    assert.deepStrictEqual(rec.splits, [1_050_000_000, 300_000_000, 150_000_000]);
    assert.strictEqual(rec.depositor.toBase58(), depositor.publicKey.toBase58());

    const pol = await C.getPolicy(connection, authority.publicKey);
    assert.strictEqual(pol.depositCount, 1);
    assert.strictEqual(pol.totalDeposited, DEPOSIT1);

    const events = C.parseEvents(await C.getLogs(connection, sig));
    assert(events.some(e => e.type === 'deposit_split' && e.amount === DEPOSIT1 && e.index === 0),
      'VAULTPILOT_EVENT deposit_split missing from logs: ' + JSON.stringify(events));
  });

  // ---- T4: floor + dust-to-treasury on an awkward amount ----
  const DEPOSIT2 = 777_777; // op 544443, res 155555, tre 77779
  await check(`deposit_and_split ${DEPOSIT2} lamports -> 544443/155555/77779 (floor + dust to treasury)`, async () => {
    const ix = await C.depositInstruction(connection, { depositor: depositor.publicKey, authority: authority.publicKey, amount: DEPOSIT2 });
    const sig = await C.signSendConfirm(connection, [ix], [depositor], 'deposit#2');
    const ret = await C.getReturnSplits(connection, sig);
    assert.deepStrictEqual(ret, [544_443, 155_555, 77_779], `return data ${ret}`);
    const pol = await C.getPolicy(connection, authority.publicKey);
    assert.strictEqual(pol.depositCount, 2);
    assert.strictEqual(pol.totalDeposited, DEPOSIT1 + DEPOSIT2);
    const rec = await C.getSplitRecord(connection, authority.publicKey, 1);
    assert(rec && rec.index === 1, 'split record #1 missing');
  });

  // ---- T5: audit trail enumeration ----
  await check('audit trail: records #0 and #1 exist, #2 does not', async () => {
    assert(await C.getSplitRecord(connection, authority.publicKey, 0));
    assert(await C.getSplitRecord(connection, authority.publicKey, 1));
    assert.strictEqual(await C.getSplitRecord(connection, authority.publicKey, 2), null);
  });

  // ---- T6: deposit into a wrong (attacker-supplied) vault is rejected ----
  await check('rejects deposit to wrong vault account (custom error 0x4 BadVault)', async () => {
    const attacker = Keypair.generate();
    const data = Buffer.alloc(9);
    data.writeUInt8(1, 0);
    data.writeBigUInt64LE(BigInt(1000), 1);
    const ix = new (require('@solana/web3.js').TransactionInstruction)({
      programId: C.PROGRAM_ID,
      keys: [
        { pubkey: depositor.publicKey, isSigner: true, isWritable: true },
        { pubkey: attacker.publicKey, isSigner: false, isWritable: true }, // wrong vault
        { pubkey: C.policyPda(authority.publicKey), isSigner: false, isWritable: true },
        { pubkey: shares.operating, isSigner: false, isWritable: true },
        { pubkey: shares.reserve, isSigner: false, isWritable: true },
        { pubkey: shares.treasury, isSigner: false, isWritable: true },
        { pubkey: C.splitRecordPda(attacker.publicKey, 0), isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data,
    });
    await expectProgramError('deposit',
      () => sendAndConfirmTransaction(connection, new Transaction().add(ix), [depositor]),
      4, 'BadVault');
  });

  console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch(e => { console.error('FATAL', e); process.exit(2); });
