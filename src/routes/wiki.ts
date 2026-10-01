// TODO: implemented by the wiki feature.
import { Hono } from 'hono';
import type { AppEnv } from '../env';

const wiki = new Hono<AppEnv>();

export default wiki;
