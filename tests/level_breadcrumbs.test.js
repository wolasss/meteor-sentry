import assert from 'assert';
import { Meteor } from 'meteor/meteor';
import Logger from 'meteor/wolas:sentry';
import {
    environment,
    dsn,
    initLogger,
    logged,
    sentryClient,
    postprocessCalls,
    markBreadcrumbs,
    breadcrumbsAfter
} from './harness.js';
import { messageBeforeInit, returnedBeforeInit } from './before_init.js';

// Every server client adds process listeners, and one more init trips Node's listener limit.
// Closing the client each init replaces, and leaving out the integrations close does not
// undo, keeps them in check (see release.test.js).
async function initWith(options = {}) {
    await sentryClient()?.close();

    return initLogger({
        sendClientReports: false,
        integrations: defaults => defaults.filter(integration =>
            !['OnUncaughtException', 'OnUnhandledRejection', 'ProcessSession', 'ChildProcess'].includes(integration.name)),
        ...options
    });
}

// Sentry's dedupe integration can drop a repeated message, so every one is unique.
let sequence = 0;

function unique(prefix) {
    sequence += 1;
    return `${prefix} level breadcrumb #${sequence}`;
}

// On the server a breadcrumb lives on the isolation scope, so the mark, the action and the
// event that carries them share one.
function inOneScope(callback) {
    return Meteor.isServer ? Logger.Sentry.withIsolationScope(callback) : callback();
}

// The logger breadcrumbs the next error event carries after action ran, and that event.
// The action is awaited before the sentinel: the harness waits on one event at a time.
function trailWithEvent(action) {
    return inOneScope(async () => {
        const mark = markBreadcrumbs();
        await action();
        const { event } = await logged('error', unique('sentinel'));

        return { breadcrumbs: breadcrumbsAfter(event, mark, 'logger'), event };
    });
}

async function trail(action) {
    return (await trailWithEvent(action)).breadcrumbs;
}

function messagesAndLevels(breadcrumbs) {
    return breadcrumbs.map(({ message, level }) => ({ message, level }));
}

describe(`level breadcrumbs on the ${environment}`, function() {
    // The next block runs under whatever init this one leaves, so it leaves a plain one.
    after(() => initWith());

    describe('with levelBreadcrumbs: true', function() {
        beforeEach(() => initWith({ levelBreadcrumbs: true }));

        it('leaves one breadcrumb for an unsent level', async function() {
            const message = unique('info');
            const breadcrumbs = await trail(() => Logger.info(message));

            assert.deepStrictEqual(messagesAndLevels(breadcrumbs), [{ message, level: 'info' }]);
        });

        it('uses the message of an Error', async function() {
            const message = unique('debug error');
            const breadcrumbs = await trail(() => Logger.debug(new Error(message)));

            assert.deepStrictEqual(messagesAndLevels(breadcrumbs), [{ message, level: 'debug' }]);
        });

        it('leaves none for a sent level', async function() {
            const breadcrumbs = await trail(() => logged('warning', unique('warning')));

            assert.deepStrictEqual(breadcrumbs, []);
        });

        it('does not copy the extra data', async function() {
            const message = unique('info with extra');
            const breadcrumbs = await trail(() => Logger.info(message, { secret: 'pii-value' }));

            assert.strictEqual(breadcrumbs.length, 1);
            assert.strictEqual(breadcrumbs[0].data, undefined);
            assert.ok(!JSON.stringify(breadcrumbs[0]).includes('pii-value'));
        });

        it('keeps the return value and runs postprocess once', function() {
            const message = unique('info returned');

            assert.strictEqual(Logger.info(message), undefined);
            assert.strictEqual(postprocessCalls.length, 1);
        });

        it('does not forward the option to Sentry', function() {
            assert.ok(!Object.prototype.hasOwnProperty.call(sentryClient().getOptions(), 'levelBreadcrumbs'));
        });

        it('leaves no breadcrumb for a call made before init', async function() {
            assert.strictEqual(returnedBeforeInit, undefined);

            // A smoke check: the flag starts off, and maxBreadcrumbs could evict a leak, so the
            // guarantee is structural. Still, no breadcrumb anywhere carries the message.
            const { event } = await trailWithEvent(() => {});
            const leaked = (event.breadcrumbs || []).filter(breadcrumb => breadcrumb.message === messageBeforeInit);

            assert.deepStrictEqual(leaked, []);
        });

        it('keeps the flag when a later init is rejected', async function() {
            assert.throws(() => Logger.init({ dsn, levels: ['warn'], levelBreadcrumbs: false }), /unknown levels/);

            const message = unique('after rejected init');
            const breadcrumbs = await trail(() => Logger.info(message));

            assert.deepStrictEqual(messagesAndLevels(breadcrumbs), [{ message, level: 'info' }]);
        });

        describe('when adding the breadcrumb fails', function() {
            const originalConsoleError = console.error;
            let consoleErrorCalls;

            beforeEach(function() {
                consoleErrorCalls = [];
                console.error = (...args) => consoleErrorCalls.push(args);
            });

            afterEach(function() {
                console.error = originalConsoleError;
            });

            it('contains the failure in the logging call', function() {
                const failure = new Error('breadcrumb failed');
                // beforeBreadcrumb is wrapped by Sentry itself; this hook's throw reaches the Logger.
                const unsubscribe = sentryClient().on('beforeAddBreadcrumb', breadcrumb => {
                    if(breadcrumb.category === 'logger') {
                        throw failure;
                    }
                });

                try {
                    let returned = 'not called';

                    assert.doesNotThrow(() => {
                        returned = Logger.info(unique('info failing'));
                    });
                    assert.strictEqual(returned, undefined);
                    assert.strictEqual(postprocessCalls.length, 1);

                    const reported = consoleErrorCalls.filter(args => args.includes(failure));

                    assert.strictEqual(reported.length, 1);
                } finally {
                    unsubscribe();
                }
            });
        });
    });

    it('maps critical to fatal when critical is not sent', async function() {
        await initWith({ levelBreadcrumbs: true, levels: ['error'] });

        const message = unique('critical');
        const breadcrumbs = await trail(() => Logger.critical(message));

        assert.deepStrictEqual(messagesAndLevels(breadcrumbs), [{ message, level: 'fatal' }]);
    });

    it('leaves none when the option is absent', async function() {
        await initWith();

        const breadcrumbs = await trail(() => Logger.info(unique('info off')));

        assert.deepStrictEqual(breadcrumbs, []);
    });

    it('leaves none after a later init turns it off', async function() {
        await initWith({ levelBreadcrumbs: true });
        await initWith({ levelBreadcrumbs: false });

        const breadcrumbs = await trail(() => Logger.info(unique('info turned off')));

        assert.deepStrictEqual(breadcrumbs, []);
    });

    it('stays off when a rejected init asks for it', async function() {
        await initWith();

        assert.throws(() => Logger.init({ dsn, levels: ['warn'], levelBreadcrumbs: true }), /unknown levels/);

        const breadcrumbs = await trail(() => Logger.info(unique('info rejected on')));

        assert.deepStrictEqual(breadcrumbs, []);
    });
});
