import * as Sentry from '@sentry/node';
import { configureMethodHandlers } from './method_errors';
import { currentInvocationContext } from './server_context';

function init(sentryOptions, { captureMethodErrors, traceMethods }) {
    const ret = Sentry.init(sentryOptions);

    configureMethodHandlers({ captureErrors: captureMethodErrors, trace: traceMethods });

    return ret;
}

export const platform = {
    Sentry,
    packageDefaults: {
        captureMethodErrors: false,
        traceMethods: false
    },
    init,
    invocationContext: currentInvocationContext
};
