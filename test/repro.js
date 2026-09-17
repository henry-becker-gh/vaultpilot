/** minimal repro: init + one deposit, dumping FULL logs */
const { Keypair, LAMPORTS_PER_SOL, Connection } = require('@solana/web3.js');
const C = require('../client');
const connection = new Connection('http://127.0.0.1:8899', 'confirmed');
(async () => {
  const authority = Keypair.generate();
  const depositor = Keypair.generate();
  for (const pk of [authority.publicKey, depositor.publicKey]) {
    for (let i = 0; i < 10; i++) {
      try { const s = await connection.requestAirdrop(pk, 2 * LAMPORTS_PER_SOL); await new Promise(r => setTimeout(r, 700)); if ((await connection.getBalance(pk)) > 0) break; } catch (e) {}
    }
  }
  console.log('authority', authority.publicKey.toBase58(), 'balance', await connection.getBalance(authority.publicKey));
  const ix0 = C.initializeInstruction({ authority: authority.publicKey, shareBps: [7000, 2000, 1000], name: 'repro' });
  const s0 = await C.signSendConfirm(connection, [ix0], [authority], 'initialize');
  console.log('init logs:', JSON.stringify(await C.getLogs(connection, s0), null, 1));
  const pol = await C.getPolicy(connection, authority.publicKey);
  console.log('policy decoded:', JSON.stringify({ ...pol, authority: pol.authority.toBase58() }));
  const ix1 = await C.depositInstruction(connection, { depositor: depositor.publicKey, authority: authority.publicKey, amount: 1_000_000_000 });
  console.log('deposit ix keys:', ix1.keys.map(k => k.pubkey.toBase58() + (k.isSigner ? '(signer)' : '') + (k.isWritable ? '(w)' : '')).join(' '));
  try {
    const s1 = await C.signSendConfirm(connection, [ix1], [depositor], 'deposit');
    console.log('DEPOSIT OK', s1);
    console.log('logs:', JSON.stringify(await C.getLogs(connection, s1), null, 1));
  } catch (e) {
    console.log('DEPOSIT FAILED');
    console.log(String(e).slice(0, 2000));
  }
})();
