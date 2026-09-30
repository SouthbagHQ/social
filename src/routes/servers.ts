// TODO: implemented by the servers feature.
import { Hono } from 'hono';
import type { AppEnv } from '../env';

const servers = new Hono<AppEnv>();

export default servers;
