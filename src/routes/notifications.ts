// TODO: implemented by the notifications feature.
import { Hono } from 'hono';
import type { AppEnv } from '../env';

const notifications = new Hono<AppEnv>();

export default notifications;
