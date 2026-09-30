// TODO: implemented by the communities feature.
import { Hono } from 'hono';
import type { AppEnv } from '../env';

const communities = new Hono<AppEnv>();

export default communities;
