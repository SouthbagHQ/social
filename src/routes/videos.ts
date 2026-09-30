// TODO: implemented by the videos feature.
import { Hono } from 'hono';
import type { AppEnv } from '../env';

const videos = new Hono<AppEnv>();

export default videos;
