// Southbag Online Banking, through a service binding (BANKING in wrangler.jsonc) to its Billing
// entrypoint — RPC between Workers, not reachable from the internet. See ../banking/worker.js.
// Banking opens an account for anyone who doesn't have one, and takes the money whatever the
// balance. Local dev and tests have no bank: with BANKING_DEV=1 (scripts/test.sh) charges succeed
// without one.

import type { Env } from '../env';

export interface BankingBilling {
  charge(input: { userId: string; email: string | null; name: string; amount: number; product: string; description: string }):
    Promise<{ balance: number; opened: boolean }>;
}

export const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/** Takes `amount` cents from the user's Southbag Online Banking account. Throws if the bank can't be reached. */
export async function charge(env: Env, user: { id: string; email: string | null; name: string }, amount: number, description: string) {
  if (String(env.BANKING_DEV ?? '') === '1') return { balance: null, opened: false };
  if (!env.BANKING) throw new Error('BANKING is not bound');
  const result = await env.BANKING.charge({ userId: user.id, email: user.email, name: user.name, amount, product: 'Southbag Social', description });
  return { balance: result.balance as number | null, opened: result.opened };
}
