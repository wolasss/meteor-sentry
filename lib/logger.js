import { Meteor } from 'meteor/meteor';

export const SeverityLevels = ['fatal', 'error', 'warning', 'log', 'info', 'debug', 'critical'];

// Chatty levels stay out of Sentry unless the app asks for them.
export const DefaultLevels = ['fatal', 'error', 'warning', 'critical'];

// Logger levels Sentry doesn't have, sent as the closest one it does.
const SentryLevelAliases = {
    critical: 'fatal'
};

function validateLevels(levels) {
    if(!Array.isArray(levels)) {
        throw new TypeError('wolas:sentry: `levels` must be an array of severity levels');
    }

    const unknownLevels = levels.filter(level => !SeverityLevels.includes(level));

    if(unknownLevels.length) {
        throw new Error(`wolas:sentry: unknown levels: ${unknownLevels.join(', ')}. Use any of: ${SeverityLevels.join(', ')}`);
    }
}

export function createLogger(platform) {
    const invocationContext = platform.invocationContext || (() => null);

    let postprocess = () => {};
    let enabledLevels = DefaultLevels;

    const logger = {};

    function send(level, event, extra) {
        const context = {
            level: SentryLevelAliases[level] || level,
            extra,
            tags: {
                key: Meteor.isClient ? 'client' : 'server'
            }
        };

        const invocation = invocationContext();

        if(invocation) {
            context.tags = { ...context.tags, ...invocation.tags };

            if(invocation.user) {
                context.user = invocation.user;
            }
        }

        if(event instanceof Error) {
            return platform.Sentry.captureException(event, context);
        }

        return platform.Sentry.captureEvent({
            message: event,
            ...context
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

            // The hook is app code: its failure must never escape the logging call
            // (on the server an escaped throw or unhandled rejection reaches Sentry's fatal handler).
            // An async hook is not awaited, so the call stays synchronous.
            const reportHookError = hookError => {
                console.error('wolas:sentry: postprocess hook threw', hookError);
            };

            try {
                const hookResult = postprocess(level, event, extra);

                if(hookResult && typeof hookResult.then === 'function') {
                    hookResult.then(undefined, reportHookError);
                }
            } catch(hookError) {
                reportHookError(hookError);
            }

            return ret;
        };
    }

    SeverityLevels.forEach(severity => {
        logger[severity] = log(severity);
    });

    logger.init = function(initOptions) {
        if(initOptions === null || typeof initOptions !== 'object') {
            throw new TypeError('wolas:sentry: Logger.init(options) requires an options object');
        }

        const { postprocess: postprocessOption, levels = DefaultLevels, ...options } = initOptions;

        validateLevels(levels);

        // Package keys start from the platform's defaults and stay out of Sentry;
        // an explicit undefined keeps the default.
        const sentryOptions = {};
        const packageOptions = { ...platform.packageDefaults };

        Object.entries(options).forEach(([name, value]) => {
            if(!Object.hasOwn(platform.packageDefaults, name)) {
                sentryOptions[name] = value;
            } else if(value !== undefined) {
                packageOptions[name] = value;
            }
        });

        if(typeof postprocessOption === 'function') {
            postprocess = postprocessOption;
        }

        enabledLevels = levels;

        return platform.init(sentryOptions, packageOptions);
    };

    return logger;
}
