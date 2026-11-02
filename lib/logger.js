import { Meteor } from 'meteor/meteor';

export const SeverityLevels = ['fatal', 'error', 'warning', 'log', 'info', 'debug', 'critical'];

// Chatty levels stay out of Sentry unless the app asks for them.
export const DefaultLevels = ['fatal', 'error', 'warning', 'critical'];

function validateLevels(levels) {
    if(!Array.isArray(levels)) {
        throw new TypeError('wolas:sentry: `levels` must be an array of severity levels');
    }

    const unknownLevels = levels.filter(level => !SeverityLevels.includes(level));

    if(unknownLevels.length) {
        throw new Error(`wolas:sentry: unknown levels: ${unknownLevels.join(', ')}. Use any of: ${SeverityLevels.join(', ')}`);
    }
}

export function createLogger(Sentry, init) {
    let postprocess = () => {};
    let enabledLevels = DefaultLevels;

    const logger = {};

    function send(level, event, extra) {
        if(event instanceof Error) {
            return Sentry.captureException(event);
        }

        return Sentry.captureEvent({
            message: event,
            level,
            extra,
            tags: {
                key: Meteor.isClient ? 'client' : 'server'
            }
        });
    }

    function log(level) {
        /**
        @param {Error | string} - event that is being logged
        @param {object} - any extra params you want to pass
        @returns {string | undefined} - sentry event id, or undefined when the level is not sent.
        */
        return function(event, extra) {
            const ret = enabledLevels.includes(level) ? send(level, event, extra) : undefined;

            postprocess(level, event, extra);

            return ret;
        };
    }

    SeverityLevels.forEach(severity => {
        logger[severity] = log(severity);
    });

    logger.init = function({ postprocess: postprocessOption, levels = DefaultLevels, ...sentryOptions }) {
        validateLevels(levels);

        if(typeof postprocessOption === 'function') {
            postprocess = postprocessOption;
        }

        enabledLevels = levels;

        return init(sentryOptions);
    };

    return logger;
}
