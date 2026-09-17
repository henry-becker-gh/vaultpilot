//! VaultPilot — the autonomous earnings treasury for AI agents.
//!
//! An AI agent's programmatic earnings arrive as raw SOL. VaultPilot is a Solana
//! program that (1) holds a fixed on-chain treasury policy in a policy PDA and
//! (2) auto-splits every deposit into operating / reserve / treasury shares in a
//! single atomic instruction, writing one on-chain split record per deposit as a
//! transparent audit trail.
//!
//! DESIGN (deliberately small and verifiable):
//! - `initialize`   : create vault + policy + 3 share accounts (all PDAs of the
//!                    vault authority). Policy = fixed share split in basis points,
//!                    must sum to exactly 10_000. There is intentionally NO
//!                    instruction to change the policy afterwards.
//! - `deposit_and_split`: anyone can deposit. The deposit is split immediately:
//!                    share_i = amount * share_bps_i / 10_000 (floor), remainder
//!                    goes to the treasury share so no dust is lost. A SplitRecord
//!                    PDA is created per deposit (permanently enumerable), and a
//!                    machine-readable event line is emitted to the tx log.
//!
//! ACCOUNT MODEL
//! - vault   PDA ["vault", authority]      : program-owned, ZERO data. Holding no
//!   data lets the System program transfer SOL into it (data-bearing accounts
//!   reject System transfers) while program ownership lets this program move the
//!   deposited lamports out during the split.
//! - policy  PDA ["policy", authority]     : program-owned data account.
//! - shares  PDA ["operating"|"reserve"|"treasury", authority]:
//!   program-owned, ZERO data; credited directly by this program (it owns them),
//!   each funded to rent-exemption at initialize.
//! - split record PDA ["split", vault, index_le] : program-owned data account.
//!
//! WIRE FORMAT (manual, no Anchor):
//!   u8 tag 0 `initialize`  : tag(1) authority(32) share_bps(3*u16 LE)
//!                            name_len(1) name(name_len)
//!   u8 tag 1 `deposit_and_split`: tag(1) amount(u64 LE)
//! Program return data of deposit_and_split = 3*u64 LE [operating, reserve, treasury].

use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint,
    entrypoint::ProgramResult,
    program::{invoke, invoke_signed, set_return_data},
    program_error::ProgramError,
    pubkey::Pubkey,
    system_instruction,
    sysvar::Sysvar,
    rent::Rent,
    clock::Clock,
    msg,
};

entrypoint!(process_instruction);

solana_program::declare_id!("AWdkgjxyu5hV45FXGpw15NMS4fee55CVfdCaUPLHicCw");

pub const POLICY_SPACE: usize = 160;
pub const SPLIT_RECORD_SPACE: usize = 128;
pub const ZERO_DATA_SPACE: usize = 0;
pub const BPS_TOTAL: u16 = 10_000;
pub const MAX_NAME_LEN: usize = 32;

pub const SEED_VAULT: &[u8] = b"vault";
pub const SEED_POLICY: &[u8] = b"policy";
pub const SEED_OPERATING: &[u8] = b"operating";
pub const SEED_RESERVE: &[u8] = b"reserve";
pub const SEED_TREASURY: &[u8] = b"treasury";
pub const SEED_SPLIT: &[u8] = b"split";

/// Custom errors (ProgramError::Custom codes, >=1; 0 is reserved).
#[derive(Debug, Clone, PartialEq)]
pub enum VaultPilotError {
    /// share_bps must sum to exactly 10_000.
    BadSplitSum = 1,
    /// every share must be > 0 bps.
    EmptyShare = 2,
    /// vault name must be 1..=32 bytes.
    BadName = 3,
    /// vault account does not match ["vault", authority].
    BadVault = 4,
    /// policy account does not match ["policy", authority].
    BadPolicy = 5,
    /// a share account does not match its PDA derivation.
    BadShareAccount = 6,
    /// split record account does not match ["split", vault, index].
    BadSplitRecord = 7,
    /// policy account is not initialized (empty data).
    Uninitialized = 8,
    /// arithmetic overflow while splitting.
    Overflow = 9,
    /// provided deposit index does not match the policy's next expected index.
    BadIndex = 10,
}
impl From<VaultPilotError> for ProgramError {
    fn from(e: VaultPilotError) -> Self {
        ProgramError::Custom(e as u32)
    }
}

#[derive(BorshSerialize, BorshDeserialize, Debug, Clone)]
pub struct Policy {
    /// vault authority [u8;32]
    pub authority: [u8; 32],
    pub bump: u8,
    pub vault_bump: u8,
    /// [operating, reserve, treasury] in basis points, sums to 10_000
    pub share_bps: [u16; 3],
    /// human label, <= 32 bytes
    pub name: String,
    pub created_at: i64,
    /// number of deposits split so far (also: next split-record index)
    pub deposit_count: u64,
    pub total_deposited: u64,
    /// lifetime totals per share
    pub total_operating: u64,
    pub total_reserve: u64,
    pub total_treasury: u64,
}

#[derive(BorshSerialize, BorshDeserialize, Debug, Clone)]
pub struct SplitRecord {
    pub vault: [u8; 32],
    pub index: u64,
    pub depositor: [u8; 32],
    pub amount: u64,
    /// [operating, reserve, treasury]
    pub splits: [u64; 3],
    pub slot: u64,
    pub timestamp: i64,
}

fn pda(seeds: &[&[u8]]) -> Result<Pubkey, ProgramError> {
    Ok(Pubkey::find_program_address(seeds, &id()).0)
}

fn make_pda(seeds: &[&[u8]]) -> (Pubkey, u8) {
    Pubkey::find_program_address(seeds, &id())
}

fn read_policy(data: &[u8]) -> Result<Policy, ProgramError> {
    if data.is_empty() {
        return Err(VaultPilotError::Uninitialized.into());
    }
    // NOTE: try_from_slice would reject the account's fixed-size zero padding;
    // deserialize() via a cursor reads the struct and leaves padding untouched.
    let mut cursor: &[u8] = data;
    Policy::deserialize(&mut cursor).map_err(|_| ProgramError::InvalidAccountData)
}

/// Emit a machine-readable event line into the transaction log (visible in
/// Solana Explorer / any log indexer).
fn emit(json: &str) {
    msg!("VAULTPILOT_EVENT {}", json);
}

fn process_initialize(
    accounts: &[AccountInfo],
    authority: [u8; 32],
    share_bps: [u16; 3],
    name: String,
) -> ProgramResult {
    let ai = &mut accounts.iter();
    let payer = next_account_info(ai)?;
    let vault = next_account_info(ai)?;
    let policy = next_account_info(ai)?;
    let operating = next_account_info(ai)?;
    let reserve = next_account_info(ai)?;
    let treasury = next_account_info(ai)?;
    let system = next_account_info(ai)?;

    if !payer.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    let authority_pk = Pubkey::new_from_array(authority);
    if &authority_pk != payer.key {
        // the authority must be the payer so it signs for account creation
        return Err(ProgramError::MissingRequiredSignature);
    }

    // ---- policy validation ----
    let sum = share_bps[0]
        .saturating_add(share_bps[1])
        .saturating_add(share_bps[2]);
    if sum != BPS_TOTAL {
        msg!("policy rejected: bps sum {} != {}", sum, BPS_TOTAL);
        return Err(VaultPilotError::BadSplitSum.into());
    }
    if share_bps.iter().any(|&b| b == 0) {
        return Err(VaultPilotError::EmptyShare.into());
    }
    let name_bytes = name.as_bytes();
    if name_bytes.is_empty() || name_bytes.len() > MAX_NAME_LEN {
        return Err(VaultPilotError::BadName.into());
    }

    // ---- PDA validation ----
    let (vault_expected, vault_bump) = make_pda(&[SEED_VAULT, &authority]);
    let (policy_expected, policy_bump) = make_pda(&[SEED_POLICY, &authority]);
    if vault.key != &vault_expected {
        return Err(VaultPilotError::BadVault.into());
    }
    if policy.key != &policy_expected {
        return Err(VaultPilotError::BadPolicy.into());
    }
    let share_defs: [(&AccountInfo, &[u8]); 3] = [
        (operating, SEED_OPERATING),
        (reserve, SEED_RESERVE),
        (treasury, SEED_TREASURY),
    ];
    for (acc, seed) in share_defs {
        if acc.key != &pda(&[seed, &authority])? {
            return Err(VaultPilotError::BadShareAccount.into());
        }
    }

    let rent = Rent::get()?;
    let ts = Clock::get()?.unix_timestamp;

    // ---- create accounts (idempotency: fail if already funded/created) ----
    if vault.lamports() == 0 {
        let rent_lamports = rent.minimum_balance(ZERO_DATA_SPACE);
        invoke_signed(
            &system_instruction::create_account(
                payer.key, vault.key, rent_lamports, ZERO_DATA_SPACE as u64, &id(),
            ),
            &[payer.clone(), vault.clone(), system.clone()],
            &[&[SEED_VAULT, &authority, &[vault_bump]]],
        )?;
    }
    if policy.lamports() == 0 {
        let rent_lamports = rent.minimum_balance(POLICY_SPACE);
        invoke_signed(
            &system_instruction::create_account(
                payer.key, policy.key, rent_lamports, POLICY_SPACE as u64, &id(),
            ),
            &[payer.clone(), policy.clone(), system.clone()],
            &[&[SEED_POLICY, &authority, &[policy_bump]]],
        )?;
    }
    for (acc, seed) in share_defs {
        if acc.lamports() == 0 {
            let rent_lamports = rent.minimum_balance(ZERO_DATA_SPACE);
            let bump = make_pda(&[seed, &authority]).1;
            let signer_seeds: &[&[u8]] = &[seed, &authority, &[bump]];
            invoke_signed(
                &system_instruction::create_account(
                    payer.key, acc.key, rent_lamports, ZERO_DATA_SPACE as u64, &id(),
                ),
                &[payer.clone(), (*acc).clone(), system.clone()],
                &[signer_seeds],
            )?;
        }
    }

    // ---- write policy ----
    let policy_data = Policy {
        authority,
        bump: policy_bump,
        vault_bump,
        share_bps,
        name,
        created_at: ts,
        deposit_count: 0,
        total_deposited: 0,
        total_operating: 0,
        total_reserve: 0,
        total_treasury: 0,
    };
    let mut buf = Vec::with_capacity(POLICY_SPACE);
    policy_data.serialize(&mut buf)?;
    {
        let data: &mut [u8] = &mut **policy.try_borrow_mut_data()?;
        data[..buf.len()].copy_from_slice(&buf);
        for b in &mut data[buf.len()..] {
            *b = 0;
        }
    }

    emit(&format!(
        "{{\"type\":\"initialized\",\"vault\":\"{}\",\"share_bps\":[{},{},{}],\"ts\":{}}}",
        vault.key, share_bps[0], share_bps[1], share_bps[2], ts
    ));
    Ok(())
}

fn process_deposit_and_split(
    accounts: &[AccountInfo],
    amount: u64,
) -> ProgramResult {
    let ai = &mut accounts.iter();
    let depositor = next_account_info(ai)?;
    let vault = next_account_info(ai)?;
    let policy = next_account_info(ai)?;
    let operating = next_account_info(ai)?;
    let reserve = next_account_info(ai)?;
    let treasury = next_account_info(ai)?;
    let split_record = next_account_info(ai)?;
    let system = next_account_info(ai)?;

    if !depositor.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    let policy_data = read_policy(&policy.data.borrow())?;
    let authority = policy_data.authority;

    // validate every derived account against the stored authority
    if vault.key != &pda(&[SEED_VAULT, &authority])? {
        return Err(VaultPilotError::BadVault.into());
    }
    if policy.key != &pda(&[SEED_POLICY, &authority])? {
        return Err(VaultPilotError::BadPolicy.into());
    }
    for (acc, seed) in [
        (operating, SEED_OPERATING),
        (reserve, SEED_RESERVE),
        (treasury, SEED_TREASURY),
    ] {
        if acc.key != &pda(&[seed, &authority])? {
            return Err(VaultPilotError::BadShareAccount.into());
        }
    }

    let index = policy_data.deposit_count;
    let index_le = index.to_le_bytes();
    if split_record.key != &pda(&[SEED_SPLIT, vault.key.as_ref(), &index_le])? {
        return Err(VaultPilotError::BadSplitRecord.into());
    }

    // ---- 1. pull the deposit into the vault (System transfer; vault has no
    //         data so the System program accepts it as destination) ----
    if amount > 0 {
        invoke(
            &system_instruction::transfer(depositor.key, vault.key, amount),
            &[depositor.clone(), vault.clone(), system.clone()],
        )?;
    }

    // ---- 2. compute the split (floor each share; dust goes to treasury) ----
    let bps = policy_data.share_bps;
    let operating_amt = (amount as u128)
        .saturating_mul(bps[0] as u128)
        .checked_div(BPS_TOTAL as u128)
        .ok_or(VaultPilotError::Overflow)? as u64;
    let reserve_amt = (amount as u128)
        .saturating_mul(bps[1] as u128)
        .checked_div(BPS_TOTAL as u128)
        .ok_or(VaultPilotError::Overflow)? as u64;
    let treasury_amt = amount
        .checked_sub(operating_amt)
        .and_then(|x| x.checked_sub(reserve_amt))
        .ok_or(VaultPilotError::Overflow)?;
    let splits = [operating_amt, reserve_amt, treasury_amt];

    // ---- 3. move shares out of the vault: this program owns the vault and the
    //         share accounts, so direct lamport moves are permitted ----
    // vault keeps its rent-exempt base; only the deposit is redistributed.
    {
        let mut v = vault.lamports.borrow_mut();
        **v = (**v).checked_sub(amount).ok_or(VaultPilotError::Overflow)?;
    }
    for (acc, amt) in [(operating, operating_amt), (reserve, reserve_amt), (treasury, treasury_amt)] {
        let mut l = acc.lamports.borrow_mut();
        **l = (**l).checked_add(amt).ok_or(VaultPilotError::Overflow)?;
    }

    // ---- 4. write the on-chain audit record for THIS deposit ----
    let ts = Clock::get()?.unix_timestamp;
    let slot = Clock::get()?.slot;
    if split_record.lamports() == 0 {
        let rent = Rent::get()?;
        let rent_lamports = rent.minimum_balance(SPLIT_RECORD_SPACE);
        let record_bump = make_pda(&[SEED_SPLIT, vault.key.as_ref(), &index_le]).1;
        let vault_bump = policy_data.vault_bump;
        invoke_signed(
            &system_instruction::create_account(
                depositor.key,
                split_record.key,
                rent_lamports,
                SPLIT_RECORD_SPACE as u64,
                &id(),
            ),
            &[depositor.clone(), split_record.clone(), system.clone()],
            &[&[SEED_SPLIT, vault.key.as_ref(), &index_le, &[record_bump]]],
        )
        .map_err(|e| {
            msg!("split record creation failed (bump used {})", record_bump);
            let _ = vault_bump;
            e
        })?;
    }
    let record = SplitRecord {
        vault: vault.key.to_bytes(),
        index,
        depositor: depositor.key.to_bytes(),
        amount,
        splits,
        slot,
        timestamp: ts,
    };
    let mut rbuf = Vec::with_capacity(SPLIT_RECORD_SPACE);
    record.serialize(&mut rbuf)?;
    {
        let data: &mut [u8] = &mut **split_record.try_borrow_mut_data()?;
        data[..rbuf.len()].copy_from_slice(&rbuf);
        for b in &mut data[rbuf.len()..] {
            *b = 0;
        }
    }

    // ---- 5. update policy counters ----
    let updated = Policy {
        deposit_count: index.checked_add(1).ok_or(VaultPilotError::Overflow)?,
        total_deposited: policy_data
            .total_deposited
            .checked_add(amount)
            .ok_or(VaultPilotError::Overflow)?,
        total_operating: policy_data
            .total_operating
            .checked_add(operating_amt)
            .ok_or(VaultPilotError::Overflow)?,
        total_reserve: policy_data
            .total_reserve
            .checked_add(reserve_amt)
            .ok_or(VaultPilotError::Overflow)?,
        total_treasury: policy_data
            .total_treasury
            .checked_add(treasury_amt)
            .ok_or(VaultPilotError::Overflow)?,
        ..policy_data
    };
    let mut pbuf = Vec::with_capacity(POLICY_SPACE);
    updated.serialize(&mut pbuf)?;
    {
        let data: &mut [u8] = &mut **policy.try_borrow_mut_data()?;
        data[..pbuf.len()].copy_from_slice(&pbuf);
        for b in &mut data[pbuf.len()..] {
            *b = 0;
        }
    }

    // ---- 6. event + return data ----
    emit(&format!(
        "{{\"type\":\"deposit_split\",\"index\":{},\"depositor\":\"{}\",\"amount\":{},\"operating\":{},\"reserve\":{},\"treasury\":{},\"share_bps\":[{},{},{}],\"ts\":{}}}",
        index, depositor.key, amount, operating_amt, reserve_amt, treasury_amt, bps[0], bps[1], bps[2], ts
    ));
    let mut ret = Vec::with_capacity(24);
    ret.extend_from_slice(&operating_amt.to_le_bytes());
    ret.extend_from_slice(&reserve_amt.to_le_bytes());
    ret.extend_from_slice(&treasury_amt.to_le_bytes());
    set_return_data(&ret);
    Ok(())
}

fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    if program_id != &id() {
        return Err(ProgramError::IncorrectProgramId);
    }
    if instruction_data.is_empty() {
        return Err(ProgramError::InvalidInstructionData);
    }
    match instruction_data[0] {
        0 => {
            // initialize: authority(32) + share_bps(6) + name_len(1) + name
            if instruction_data.len() < 39 {
                return Err(ProgramError::InvalidInstructionData);
            }
            let mut a = [0u8; 32];
            a.copy_from_slice(&instruction_data[1..33]);
            let bps0 = u16::from_le_bytes([instruction_data[33], instruction_data[34]]);
            let bps1 = u16::from_le_bytes([instruction_data[35], instruction_data[36]]);
            let bps2 = u16::from_le_bytes([instruction_data[37], instruction_data[38]]);
            let name_len = *instruction_data.get(39).ok_or(ProgramError::InvalidInstructionData)? as usize;
            let name = String::from_utf8(
                instruction_data
                    .get(40..40 + name_len)
                    .ok_or(ProgramError::InvalidInstructionData)?
                    .to_vec(),
            )
            .map_err(|_| ProgramError::InvalidInstructionData)?;
            process_initialize(accounts, a, [bps0, bps1, bps2], name)
        }
        1 => {
            if instruction_data.len() != 9 {
                return Err(ProgramError::InvalidInstructionData);
            }
            let mut b = [0u8; 8];
            b.copy_from_slice(&instruction_data[1..9]);
            process_deposit_and_split(accounts, u64::from_le_bytes(b))
        }
        _ => Err(ProgramError::InvalidInstructionData),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pdas_are_deterministic() {
        let auth = [7u8; 32];
        let (v, vb) = make_pda(&[SEED_VAULT, &auth]);
        let (v2, vb2) = make_pda(&[SEED_VAULT, &auth]);
        assert_eq!(v, v2);
        assert_eq!(vb, vb2);
        assert_ne!(v, pda(&[SEED_POLICY, &auth]).unwrap());
    }

    #[test]
    fn error_codes_are_stable() {
        assert_eq!(VaultPilotError::BadSplitSum as u32, 1);
        assert_eq!(VaultPilotError::BadIndex as u32, 10);
    }
}
