// TODO: implemented by the marketplace feature.
import { Hono } from 'hono';
import type { AppEnv } from '../env';

const marketplace = new Hono<AppEnv>();

export default marketplace;
