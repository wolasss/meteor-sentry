import { platform } from './server';
import { createLogger } from './logger';

export const Sentry = platform.Sentry;

export default createLogger(platform);
