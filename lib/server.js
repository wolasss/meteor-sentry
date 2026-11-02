import * as Sentry from '@sentry/node';
import { installMethodErrorCapture } from './method_errors';

export function init(sentryOptions, {
    captureMethodErrors = false
} = {}) {
    const ret = Sentry.init(sentryOptions);

    if(captureMethodErrors) {
        installMethodErrorCapture();
    }

    return ret;
}
