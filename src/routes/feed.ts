// TODO: implemented by the feed feature.
import { Hono } from 'hono';
import type { AppEnv } from '../env';

const feed = new Hono<AppEnv>();

export default feed;
