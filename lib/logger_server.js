import { platform } from './server';
import { createLogger } from './logger';

export const Sentry = platform.sentry();

export default createLogger(platform);
