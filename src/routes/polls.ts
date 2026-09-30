// TODO: implemented by the polls feature.
import { Hono } from 'hono';
import type { AppEnv } from '../env';

const polls = new Hono<AppEnv>();

export default polls;
