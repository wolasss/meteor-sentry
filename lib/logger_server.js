import { platform } from './server';
import { createLogger } from './logger';

export default createLogger(platform);
