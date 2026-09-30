// TODO: implemented by the users feature.
import { Hono } from 'hono';
import type { AppEnv } from '../env';

const users = new Hono<AppEnv>();

export default users;
