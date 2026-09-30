// TODO: implemented by the stories feature.
import { Hono } from 'hono';
import type { AppEnv } from '../env';

const stories = new Hono<AppEnv>();

export default stories;
