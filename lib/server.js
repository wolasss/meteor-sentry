import * as Sentry from '@sentry/node';
import { installMethodErrorCapture } from './method_errors';
import { currentInvocationContext } from './server_context';

function init(sentryOptions, { captureMethodErrors }) {
    const ret = Sentry.init(sentryOptions);

    if(captureMethodErrors) {
        installMethodErrorCapture();
    }

    return ret;
}

export const platform = {
    Sentry,
    packageDefaults: {
        captureMethodErrors: false
    },
    init,
    invocationContext: currentInvocationContext
};
