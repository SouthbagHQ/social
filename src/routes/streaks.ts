// TODO: implemented by the streaks feature.
import { Hono } from 'hono';
import type { AppEnv } from '../env';

const streaks = new Hono<AppEnv>();

export default streaks;

/** Hourly job (called from the Worker's scheduled handler). Replaced by the streaks feature. */
export async function streaksCron(_env: import('../env').Env): Promise<void> {}
