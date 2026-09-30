// TODO: implemented by the groups feature.
import { Hono } from 'hono';
import type { AppEnv } from '../env';

const groups = new Hono<AppEnv>();

export default groups;
