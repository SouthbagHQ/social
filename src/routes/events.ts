// TODO: implemented by the events feature.
import { Hono } from 'hono';
import type { AppEnv } from '../env';

const events = new Hono<AppEnv>();

export default events;
