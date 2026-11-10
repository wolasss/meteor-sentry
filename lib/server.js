import * as Sentry from '@sentry/node';
import { configureMethodHandlers } from './method_errors';
import { configurePublicationHandlers } from './publication_handlers';
import { currentInvocationContext } from './server_context';

function init(sentryOptions, { captureMethodErrors, traceMethods, tracePublications }) {
    const ret = Sentry.init(sentryOptions);

    configureMethodHandlers({ captureErrors: captureMethodErrors, trace: traceMethods });
    configurePublicationHandlers({ trace: tracePublications });

    return ret;
}

export const platform = {
    sentry: () => Sentry,
    // Already loaded: the server imports the SDK statically. Kept async to match the client.
    load: () => Promise.resolve(Sentry),
    packageDefaults: {
        captureMethodErrors: false,
        traceMethods: false,
        tracePublications: false
    },
    init,
    invocationContext: currentInvocationContext
};
