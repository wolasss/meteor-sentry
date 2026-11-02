import * as Sentry from '@sentry/node';

export function init(sentryOptions) {
    Sentry.init(sentryOptions);
}
