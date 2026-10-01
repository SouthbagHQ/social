// TODO: implemented by the boards feature.
import { Hono } from 'hono';
import type { AppEnv } from '../env';

const boards = new Hono<AppEnv>();

export default boards;
