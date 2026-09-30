// TODO: implemented by the pins feature.
import { Hono } from 'hono';
import type { AppEnv } from '../env';

const pins = new Hono<AppEnv>();

export default pins;
