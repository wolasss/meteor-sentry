import { platform } from './client';
import { createLogger } from './logger';

// Live: undefined until Logger.load() resolves.
export { Sentry } from './client_sdk';

export default createLogger(platform);
