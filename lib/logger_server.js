import * as Sentry from '@sentry/node';
import { init } from './server';
import { createLogger } from './logger';

export default createLogger(Sentry, init);
