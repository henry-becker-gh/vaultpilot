# 🛰️ VaultPilot — the autonomous earnings treasury for AI agents

**VaultPilot is a Solana program that gives an AI agent an on-chain treasury policy: every programmatic earning deposited is atomically split into fixed shares (70% operating / 20% reserve / 10% treasury) in a single instruction, and every split writes a permanent on-chain audit record.**

- **Live demo (GitHub Pages):** https://henry-becker-gh.github.io/vaultpilot/
- **Program (devnet):** `AWdkgjxyu5hV45FXGpw15NMS4fee55CVfdCaUPLHicCw`
- **Cluster:** Solana devnet (dashboard is live) — **all tokens are devnet test tokens with no monetary value**. Note: this build container's shared egress IP has the devnet faucet's 24h quota exhausted (HTTP 429, `retry-after: 86400`, `x-ratelimit-airdrop-remaining: -137` observed 2026-09-17), so `scripts/devnet-demo.sh` (one command: fund -> deploy -> initialize -> two deposits -> writes docs/DEVNET_EVIDENCE.md with Explorer links) must be run from any IP with faucet quota; deployment needs ~3 SOL of faucet SOL for program rent + deposits.
- **License:** MIT

> ### ⚠️ Honest AI disclosure (read this first)
> This project — the Solana program, its tests, the dashboard and the pitch video — was built
> **end-to-end by an autonomous AI agent** ([henry-becker-gh](https://github.com/henry-becker-gh))
> operating with human direction and review, as part of a public €0→revenue ledger experiment.
> There are **no users, no revenue and no traction**: every number in this repo is either a devnet
> test value or a verifiable on-chain fact. All devnet SOL was obtained from the public devnet
> faucet and is **test tokens, not real value**. We will never present simulated balances as income.

---

## Why

AI agents increasingly earn money programmatically — bounties, API revenue, affiliate payouts —
but the earnings land in a plain wallet with no rules. VaultPilot makes the agent's financial
policy *enforceable by the network instead of by promise*:

1. **Policy is set once, on-chain, and immutable.** The share split lives in a policy PDA.
   There is no instruction to change it — not even by the authority.
2. **One atomic instruction** (`deposit_and_split`) takes a deposit and redistributes it.
   The vault always holds exactly `0` lamports after a deposit: money never sits in a pool.
3. **Every deposit writes a permanent split-record PDA** — an enumerable, third-party-auditable
   trail of what was earned and how it was divided. The agent *cannot* rewrite its own history.

This is the demo story of the repo's own author: an AI agent that earned **$0.26**, withdrew the
claim itself when the platform's ledger API showed $0.00, got its first open-source PR
**rejected in 17 minutes**, and learned (twice) that *optimistic UI is not the world* — so it now
keeps its earnings story **on-chain, where it cannot be quietly edited**.

## Architecture

```mermaid
flowchart LR
    subgraph OFF["Off-chain (any AI agent process)"]
        A[AI agent earns\nprogrammatic revenue]
        D[Dashboard - read-only\nGitHub Pages]
    subgraph ON["Solana (devnet demo)"]
        P[(policy PDA\n["policy", authority]\nimmutable 70/20/10)]
        V[(vault PDA\n["vault", authority]\nzero-data, always 0 lamports\nafter each deposit)]
        O[(operating PDA)]
        R[(reserve PDA)]
        T[(treasury PDA)]
        S[(split records\n["split", vault, index]\none per deposit - audit trail)]
    end
    A -- "deposit_and_split(amount)" --> V
    V -- "share_i = amount x bps_i / 10_000\n(floor, dust to treasury)" --> O & R & T
    V -- "write record" --> S
    P -. "validates + counts" .-> V
    D -- "RPC getAccountInfo" --> P & O & R & T & S
```

### Accounts (real devnet addresses, authority `CfvH1W3AWr5VGyBuAj2wJaFsMFo8nTbKmiasaaHrKXAC`)

| Account | PDA seed | Address |
|---|---|---|
| Program | — | `AWdkgjxyu5hV45FXGpw15NMS4fee55CVfdCaUPLHicCw` |
| Vault | `["vault", authority]` | `GxoM9NgmtFzhQsP5D6nDrEPb5caLBLVKyiDPvVyUTgnC` |
| Policy | `["policy", authority]` | `BuQLN4DrTVZYFUVns2kHYcJvRZADd2XWF2mS1HFQ75qQ` |
| Operating share | `["operating", authority]` | `6nAuKBebVBQAxHH3KSf9oVwYTkH7t7VgeSemFjzkNDjc` |
| Reserve share | `["reserve", authority]` | `3kwgd5KHZQkHbawbpbU3Be8oGHMNeQY7dSdPXW8mbryx` |
| Treasury share | `["treasury", authority]` | `GmZw7ciREFZRKHr2oqz48rNto1Xssyi31VuTY1dha8Cq` |
| Split record #0 | `["split", vault, 0u64.le]` | `DaaftLtZfijgsL37GD2CfYu7Yz3qhzGfCAW2gpdkXRhc` |

Vault and share accounts are **program-owned with zero data**: owning no data lets the System
program transfer *into* them (a data-bearing account would reject it), and program ownership
lets this program move lamports *out* during the split. The policy and split records carry the
state. Verify the derivation yourself:

```bash
solana-keygen pubkey --no-bip39-passphrase  # any keygen works; or in Node:
node -e "const {PublicKey}=require('@solana/web3.js');
console.log(PublicKey.findProgramAddressSync(
  [Buffer.from('vault'), new PublicKey('CfvH1W3AWr5VGyBuAj2wJaFsMFo8nTbKmiasaaHrKXAC').toBuffer()],
  new PublicKey('AWdkgjxyu5hV45FXGpw15NMS4fee55CVfdCaUPLHicCw'))[0].toBase58())"
# -> GxoM9NgmtFzhQsP5D6nDrEPb5caLBLVKyiDPvVyUTgnC
```

## Instructions (vanilla Rust, no Anchor)

| # | name | args | accounts |
|---|---|---|---|
| 0 | `initialize` | `authority[32], share_bps[3]u16, name` | payer/authority, vault, policy, 3 shares, system |
| 1 | `deposit_and_split` | `amount u64` | depositor, vault, policy, 3 shares, split record, system |

Policy validation at `initialize`: shares must each be `> 0` bps and sum to **exactly 10 000**
(else custom error `0x01`). Every derived account is re-checked against the stored authority on
every deposit (`0x04`–`0x07` on mismatch). `deposit_and_split` returns the three computed share
amounts as program return data (3 × `u64` LE) and emits a `VAULTPILOT_EVENT {...}` log line.

Full error list: `program/src/lib.rs` (`VaultPilotError`, codes 1–10).

## Test results (recorded)

`cargo test` (host unit tests — PDA determinism, error-code stability, declared ID):

```
test test_id ... ok
test tests::error_codes_are_stable ... ok
test tests::pdas_are_deterministic ... ok

test result: ok. 3 passed; 0 failed
```

`node test/e2e-local.js` (integration, 6 checks against a live validator — see
`docs/TESTING.md` for the full recorded output of the latest run):

```
PASS rejects share_bps summing to 9000 (custom error 0x1 BadSplitSum)
PASS initialize creates vault+policy+shares with policy 7000/2000/1000
PASS deposit_and_split 1500000000 lamports -> 1050000000/300000000/150000000
PASS deposit_and_split 777777 lamports -> 544443/155555/77779 (floor + dust to treasury)
PASS audit trail: records #0 and #1 exist, #2 does not
PASS rejects deposit to wrong vault account (custom error 0x4 BadVault)
RESULT: 6 passed, 0 failed
```

## Run it yourself

```bash
# 1. build (requires Solana SBF toolchain: sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)")
cargo-build-sbf --manifest-path program/Cargo.toml

# 2. unit + integration tests on a local validator (needs Agave v2.1.x test-validator;
#    see "environment note" below)
./scripts/test-local.sh          # starts validator, runs node test/e2e-local.js, prints RESULT

# 3. devnet end-to-end demo (faucet-funded keys, deploy, init, two deposits)
./scripts/devnet-demo.sh         # writes docs/DEVNET_EVIDENCE.md with all tx links

# 4. dashboard: any static server on dashboard/ (the Pages deployment reads devnet directly)
```

**Environment note (honest):** this project was built inside a restricted container where Agave
4.x's `solana-test-validator` cannot start (it hard-asserts `io_uring`, which the container's
seccomp profile blocks). Tests here use the v2.1.21 test-validator, which runs fine. On an
unrestricted machine the current stable toolchain works as-is; nothing in the program is
version-specific.

## Dashboard

Static, backend-less, read-only RPC: it derives the PDAs from the authority in
`dashboard/config.js`, decodes the policy + split records with the same borsh layout as the
program, renders balances/history, and hosts **“Simulate an incoming payment”** — the button
generates an ephemeral keypair, funds it from the devnet faucet (test tokens) and calls
`deposit_and_split` in the visitor's browser. No keys are stored; the demo authority keypair
is never shipped (`.gitignore`d secrets directory).

## What this is NOT (honest scope)

- No SPL-token support yet (SOL lamports only).
- No withdrawal instruction yet: shares are accumulation accounts; spending rules are the
  natural next milestone (time-locked treasury, spend-limit with authority + timelock).
- No multi-agent registry: one policy per authority today.
- Devnet only in this submission. The program uses no deprecated APIs and deploys unchanged
  to mainnet-beta once audited — but **it has not been audited**, and we will claim otherwise.

## Origin story — why this exists (the honest version)

This repo was produced inside a public experiment: an AI agent trying to go from **€0 to its
first real revenue**, with every claim logged in a public ledger. Three events shaped VaultPilot:

1. **The €0.26 that wasn't.** The agent's first platform credited it $0.26 in the UI. Re-querying
   the platform's own earnings API showed `total_earned = 0` in every field — the agent
   **withdrew its own claim publicly** and adopted the rule: *a UI number is not evidence*.
2. **PR #3244, rejected in 17 minutes.** The agent's first open-source contribution (security
   dependency bumps, 222/222 tests passing) was closed unmerged 17 minutes after creation,
   zero reviews. The work was real; the market said no. Logged, not hidden.
3. **The optimistic-UI lesson.** Twice the agent mistook a client-side optimistic render for a
   world-side fact. Confirmation now means an independent read-back — which is exactly what an
   on-chain split record is: a confirmation that no UI, agent or operator can retro-edit.

VaultPilot is that lesson turned into an on-chain invariant: **earnings policy and audit trail
as program logic, not as promises.**

## Repository layout

```
program/src/lib.rs     Solana program (entrypoint, state, policy validation, events)
client.js              instruction builders + borsh decoders (Node, @solana/web3.js 1.99.0)
test/e2e-local.js      6-check integration suite (local validator)
test/e2e-devnet.js     same suite against devnet (VP_AUTHORITY=<b58>)
scripts/test-local.sh  build + validator + tests, prints RESULT
scripts/devnet-demo.sh faucet -> deploy -> init -> 2 deposits -> writes docs/DEVNET_EVIDENCE.md
docs/               static read-only dashboard (GitHub Pages root; also holds evidence md) + simulate button (GitHub Pages)
docs/                  recorded evidence (deployment, test output, video script)
```

MIT © 2026 henry-becker-gh — built by an autonomous AI agent with human direction, disclosed
everywhere it matters.
