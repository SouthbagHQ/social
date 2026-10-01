// Southbag Online Banking, through a service binding (BANKING in wrangler.jsonc) to its Billing
// entrypoint — RPC between Workers, not reachable from the internet. See ../banking/worker.js.
// Banking opens an account for anyone who doesn't have one. Local dev and tests have no bank: with
// BANKING_DEV=1 (scripts/test.sh) a stand-in answers instead (charges and transfers succeed, except
// transfers over $5,000, which fail for lack of funds).

import type { Env } from '../env';

export interface Customer { userId: string; email: string | null; name: string }
export interface TransferResult { ok: boolean; error?: string; text: string; amount?: number; fees?: number; balance?: number }
export interface BankAccount {
  balance: number;
  account_number: string | null;
  status: string;
  transactions: { amount: number; kind: string; description: string; created_at: number }[];
}

export interface BankingBilling {
  charge(input: Customer & { amount: number; product: string; description: string }): Promise<{ balance: number; opened: boolean }>;
  transfer(input: { from: Customer; to: Customer; amount: number }): Promise<TransferResult>;
  account(input: { userId: string }): Promise<BankAccount | null>;
}

export const money = (cents: number) => `${cents < 0 ? '-' : ''}$${(Math.abs(cents) / 100).toFixed(2)}`;

const dev = (env: Env) => String(env.BANKING_DEV ?? '') === '1';
const bank = (env: Env) => {
  if (!env.BANKING) throw new Error('BANKING is not bound');
  return env.BANKING;
};
const customer = (user: { id: string; email: string | null; name: string }): Customer =>
  ({ userId: user.id, email: user.email, name: user.name });

/** Takes `amount` cents from the user's Southbag Online Banking account. Throws if the bank can't be reached. */
export async function charge(env: Env, user: { id: string; email: string | null; name: string }, amount: number, description: string) {
  if (dev(env)) return { balance: null, opened: false };
  const result = await bank(env).charge({ ...customer(user), amount, product: 'Southbag Social', description });
  return { balance: result.balance as number | null, opened: result.opened };
}

/**
 * Sends `amount` cents from one person's account to another's, with Southbag Online Banking's
 * transfer fees on top (paid by the sender). A refusal (frozen account, not enough money) comes
 * back as `{ ok: false, text }`; throws only if the bank can't be reached.
 */
export async function transfer(env: Env, from: { id: string; email: string | null; name: string },
  to: { id: string; email: string | null; name: string }, amount: number): Promise<TransferResult> {
  if (dev(env)) {
    return amount > 500000
      ? { ok: false, error: 'insufficient', text: `Need ${money(amount)}, have $5,000.00.` }
      : { ok: true, text: `Sent ${money(amount)}.`, amount, fees: 0, balance: 500000 - amount };
  }
  return bank(env).transfer({ from: customer(from), to: customer(to), amount });
}

/** The user's account (balance and recent transactions), or null if they don't have one yet. */
export async function account(env: Env, user: { id: string }): Promise<BankAccount | null> {
  if (dev(env)) return { balance: 500000, account_number: '0000-SBAG-00000-D', status: 'active', transactions: [] };
  return bank(env).account({ userId: user.id });
}
