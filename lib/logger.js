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

// The release Sentry would not find by itself: the commit Meteor was built from.
// An operator's SENTRY_RELEASE (server) or a bundler-injected release still wins.
function defaultRelease() {
    if(Meteor.isServer && process.env.SENTRY_RELEASE) {
        return undefined;
    }

    // typeof is safe on an undeclared identifier; a bundler define replaces it with a string.
    if(typeof __SENTRY_RELEASE__ === 'string' || globalThis.SENTRY_RELEASE?.id) {
        return undefined;
    }

    const hash = Meteor.gitCommitHash;

    return typeof hash === 'string' && hash !== '' ? hash : undefined;
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

        const Sentry = platform.sentry();

        // Before Logger.load() on the client there is no SDK yet. Like a call before
        // Logger.init, it sends nothing.
        if(!Sentry) {
            return undefined;
        }

        if(event instanceof Error) {
            return Sentry.captureException(event, context);
        }

        return Sentry.captureEvent({
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

    // The SDK the Logger's events go through, for what the Logger does not wrap (setTag, withScope, flush, ...).
    // Read-only: swapping it would not change where the Logger sends. Undefined on the
    // client until Logger.load() resolves.
    Object.defineProperty(logger, 'Sentry', { get: platform.sentry, enumerable: true });

    // The client fetches its SDK on the first call. On the server it is already loaded.
    logger.load = () => platform.load();

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
            if(!Object.prototype.hasOwnProperty.call(platform.packageDefaults, name)) {
                sentryOptions[name] = value;
            } else if(value !== undefined) {
                packageOptions[name] = value;
            }
        });

        // Any release the app passed wins, even an empty one.
        if(sentryOptions.release === undefined) {
            const release = defaultRelease();

            if(release !== undefined) {
                sentryOptions.release = release;
            }
        }

        const client = platform.init(sentryOptions, packageOptions);

        // Like levels, the hook belongs to this init: leaving it out clears an earlier one.
        // Both apply only once Sentry accepted the init, so a rejected one changes neither.
        postprocess = typeof postprocessOption === 'function' ? postprocessOption : () => {};
        enabledLevels = levels;

        return client;
    };

    return logger;
}
