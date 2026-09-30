// TODO: implemented by the posts feature.
import { Hono } from 'hono';
import type { AppEnv } from '../env';

const posts = new Hono<AppEnv>();

export default posts;
