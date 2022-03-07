import * as Sentry from '@sentry/node';
import { Meteor } from 'meteor/meteor';
import { init } from './server';

let postprocess = () => {};

const logger = {};

function log(level) {
    /**
    @param {Error | string} - event that is being logged
    @param {object} - any extra params you want to pass
    @returns {string} - sentry event id.
    */
    return function(event, extra) {
        let ret;

        if(event instanceof Error) {
            ret = Sentry.captureException(event);
        } else {
            ret = Sentry.captureEvent({
                message: event,
                level,
                extra,
                tags: {
                    key: Meteor.isClient ? 'client' : 'server'
                }
            });
        }

        postprocess(level, event, extra);

        return ret;
    };
}

const SeverityLevels = ['fatal', 'error', 'warning', 'log', 'info', 'debug', 'critical'];

SeverityLevels.forEach(severity => {
    logger[severity] = log(severity);
});

logger.init = function(options) {
    if(typeof options.postprocess === 'function') {
        postprocess = options.postprocess;
    }

    init(options);
};

export default logger;
