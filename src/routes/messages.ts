// TODO: implemented by the messages feature.
import { Hono } from 'hono';
import type { AppEnv } from '../env';

const messages = new Hono<AppEnv>();

export default messages;
