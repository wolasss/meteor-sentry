import * as Sentry from '@sentry/browser';
import { init } from './client';
import { createLogger } from './logger';

export default createLogger(Sentry, init);
