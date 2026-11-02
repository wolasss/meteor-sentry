import * as Sentry from '@sentry/node';
import { init } from './server';
import { createLogger } from './logger';
import { currentInvocationContext } from './server_context';

export default createLogger(Sentry, init, currentInvocationContext, ['captureMethodErrors']);
