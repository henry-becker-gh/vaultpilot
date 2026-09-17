/* VaultPilot dashboard logic — read-only RPC views + simulate button. */
const { Buffer } = require('buffer');
globalThis.Buffer = Buffer;
const {
  Connection, PublicKey, Keypair, LAMPORTS_PER_SOL, SystemProgram,
  Transaction, TransactionInstruction, sendAndConfirmTransaction,
} = require('@solana/web3.js');
const C = require('../client');

const CFG = window.VAULTPILOT_CONFIG;
const connection = new Connection(CFG.RPC_URL, 'confirmed');
const PROGRAM_ID = new PublicKey(CFG.PROGRAM_ID);
const authority = new PublicKey(CFG.AUTHORITY);

const $ = (id) => document.getElementById(id);
const short = (pk) => pk.slice(0, 4) + '…' + pk.slice(-4);
const sol = (lamports, digits = 5) => (lamports / LAMPORTS_PER_SOL).toFixed(digits);
const link = (pk) => `https://explorer.solana.com/address/${pk}?cluster=devnet`;
const txlink = (sig) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;

function kv(k, v) { return `<div class="kv"><span class="k">${k}</span><span class="v">${v}</span></div>`; }
function logline(s) { const el = $('simlog'); el.textContent += `\n${s}`; el.scrollTop = el.scrollHeight; }

async function main() {
  $('badge-program').textContent = 'program ' + short(PROGRAM_ID.toBase58());
  $('statusline').textContent = `RPC ${CFG.RPC_URL} · cluster devnet`;

  const pol = await C.getPolicy(connection, authority);
  if (!pol) { $('statusline').innerHTML = '<span class="err">vault not initialized on devnet yet — run scripts/devnet-demo.sh</span>'; return; }

  $('badge-cluster').textContent = '● devnet · policy LIVE';
  $('policy-kv').innerHTML =
    kv('name', pol.name) +
    kv('shares', pol.shareBps.map(b => (b / 100).toFixed(0) + '%').join(' / ')) +
    kv('deposits split', pol.depositCount) +
    kv('authority', `<a href="${link(pol.authority)}">${short(pol.authority.toBase58())}</a>`) +
    kv('initialized', new Date(pol.createdAt * 1000).toISOString().replace('T', ' ').slice(0, 16));

  const vault = C.vaultPda(authority);
  const shares = {
    operating: C.sharePda(C.SEED_OPERATING, authority),
    reserve: C.sharePda(C.SEED_RESERVE, authority),
    treasury: C.sharePda(C.SEED_TREASURY, authority),
  };
  const bal = async (pk) => (await connection.getBalance(pk));
  const [vb, ob, rb, tb] = await Promise.all([bal(vault), bal(shares.operating), bal(shares.reserve), bal(shares.treasury)]);
  $('accounts-kv').innerHTML =
    kv('vault PDA', `<a href="${link(vault.toBase58())}">${short(vault.toBase58())}</a> · ${sol(vb)} SOL`) +
    kv('operating', `<a href="${link(shares.operating.toBase58())}">${short(shares.operating.toBase58())}</a> · <span class="ok">${sol(ob)} SOL</span>`) +
    kv('reserve', `<a href="${link(shares.reserve.toBase58())}">${short(shares.reserve.toBase58())}</a> · <span style="color:var(--reserve)">${sol(rb)} SOL</span>`) +
    kv('treasury', `<a href="${link(shares.treasury.toBase58())}">${short(shares.treasury.toBase58())}</a> · <span style="color:var(--treasury)">${sol(tb)} SOL</span>`) +
    kv('program', `<a href="${link(PROGRAM_ID.toBase58())}">${short(PROGRAM_ID.toBase58())}</a> · deployed`);

  $('totals-kv').innerHTML =
    kv('total deposited', sol(pol.totalDeposited) + ' SOL') +
    kv('→ operating', sol(pol.totalOperating) + ' SOL') +
    kv('→ reserve', sol(pol.totalReserve) + ' SOL') +
    kv('→ treasury', sol(pol.totalTreasury) + ' SOL') +
    kv('vault held lamports', '0 (everything is split instantly)');

  // history
  if (pol.depositCount === 0) {
    $('history').innerHTML = '<tr><td colspan="7" style="color:var(--muted)">no deposits yet — use the simulate button</td></tr>';
  } else {
    const rows = [];
    for (let i = pol.depositCount - 1; i >= 0; i--) {
      const rec = await C.getSplitRecord(connection, authority, i);
      if (!rec) continue;
      rows.push(`<tr><td class="mono">${rec.index}</td>` +
        `<td>${new Date(rec.timestamp * 1000).toISOString().replace('T', ' ').slice(0, 19)}</td>` +
        `<td class="mono"><a href="${link(rec.depositor.toBase58())}">${short(rec.depositor.toBase58())}</a></td>` +
        `<td class="num">${sol(rec.amount)}</td><td class="num" style="color:var(--operating)">${sol(rec.splits[0])}</td>` +
        `<td class="num" style="color:var(--reserve)">${sol(rec.splits[1])}</td><td class="num" style="color:var(--treasury)">${sol(rec.splits[2])}</td></tr>`);
    }
    $('history').innerHTML = rows.join('') || '<tr><td colspan="7">records not found</td></tr>';
  }
  $('statusline').innerHTML = `<span class="ok">● live</span> · ${pol.depositCount} deposits split · policy ${pol.shareBps.map(b => (b / 100).toFixed(0) + '%').join('/')} · devnet test tokens only`;
}

$('simulate').addEventListener('click', async () => {
  const btn = $('simulate');
  btn.disabled = true; $('simlog').textContent = 'starting…';
  try {
    logline('1/5 generating fresh ephemeral keypair…');
    const depositor = Keypair.generate();
    logline('    ' + depositor.publicKey.toBase58());
    logline('2/5 requesting devnet faucet airdrop (test tokens)…');
    let funded = false;
    for (let i = 0; i < 6 && !funded; i++) {
      try {
        const bh = await connection.getLatestBlockhash();
        const sig = await connection.requestAirdrop(depositor.publicKey, 1 * LAMPORTS_PER_SOL);
        const latest = await connection.getLatestBlockhash();
        await connection.confirmTransaction({ signature: sig, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight }, 'confirmed');
        funded = true;
      } catch (e) { logline(`    faucet attempt ${i + 1} failed (${String(e.message || e).slice(0, 60)}) — retrying…`); await new Promise(r => setTimeout(r, 2500)); }
    }
    if (!funded) throw new Error('devnet faucet rate-limited right now — try again in a few minutes (nothing is broken)');
    logline('    funded 1.00000 test SOL ✔');
    const pol = await C.getPolicy(connection, authority);
    logline('3/5 building deposit_and_split(1.0 SOL)…');
    const ix = await C.depositInstruction(connection, { depositor: depositor.publicKey, authority, amount: 1 * LAMPORTS_PER_SOL });
    logline('4/5 sending transaction…');
    const tx = new Transaction().add(ix);
    const sig = await connection.sendTransaction(tx, [depositor]);
    const latest = await connection.getLatestBlockhash();
    await connection.confirmTransaction({ signature: sig, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight }, 'confirmed');
    logline('5/5 split confirmed ✔');
    logline(`tx: ${txlink(sig)}`);
    const ret = await C.getReturnSplits(connection, sig);
    if (ret) logline(`split → operating ${sol(ret[0])} / reserve ${sol(ret[1])} / treasury ${sol(ret[2])} SOL`);
    await main();
  } catch (e) {
    logline('ERROR: ' + String(e.message || e).slice(0, 300));
  } finally { btn.disabled = false; }
});

main().catch(e => { $('statusline').innerHTML = '<span class="err">' + String(e.message || e).slice(0, 200) + '</span>'; });
