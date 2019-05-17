import * as Sentry from '@sentry/node';

export function init(sentryOptions) {
    Sentry.init(sentryOptions);
}

process.on('uncaughtException', function(err) {
    Sentry.captureException(err);

    console.error(err);
});
