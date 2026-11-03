import { Meteor } from 'meteor/meteor';
import assert from 'assert';
import Logger from 'meteor/wolas:sentry';

const SeverityLevels = ['fatal', 'error', 'warning', 'log', 'info', 'debug', 'critical'];
const environment = Meteor.isClient ? 'client' : 'server';
const dsn = 'https://public@sentry.invalid/1';

let pendingEvent;
const sentEvents = [];
const hookCalls = [];
const replacementHookCalls = [];

function init(options = {}) {
    return Logger.init({
        dsn,
        beforeSend(event) {
            sentEvents.push(event);
            pendingEvent?.(event);
            pendingEvent = undefined;

            // Never send anything over the network.
            return null;
        },
        postprocess(level, event, extra) {
            hookCalls.push({ level, event, extra });
        },
        ...options
    });
}

// Passed only to inits that must be rejected: a call here means a rejected init half-applied.
function replacementHook(level, event, extra) {
    replacementHookCalls.push({ level, event, extra });
}

function nextEvent() {
    return new Promise(resolve => {
        pendingEvent = resolve;
    });
}

function yieldMacrotask() {
    return new Promise(resolve => setTimeout(resolve, 0));
}

async function withSilentConsoleError(callback) {
    const originalConsoleError = console.error;
    const consoleErrorCalls = [];
    console.error = (...args) => consoleErrorCalls.push(args);

    try {
        await callback();
    } finally {
        console.error = originalConsoleError;
    }

    return consoleErrorCalls;
}

// Each message is unique, or Sentry's dedupe integration drops repeats.
async function assertOnlyInfoEnabled(tag) {
    sentEvents.length = 0;
    hookCalls.length = 0;
    const errorMessage = `reinit ${tag}: error`;
    const infoMessage = `reinit ${tag}: info`;

    assert.strictEqual(Logger.error(errorMessage), undefined);

    // The info event doubles as a sentinel: had the error been queued, it would reach beforeSend first.
    const captured = nextEvent();
    const eventId = Logger.info(infoMessage);
    const event = await captured;

    assert.strictEqual(typeof eventId, 'string');
    assert.strictEqual(eventId, event.event_id);
    assert.deepStrictEqual(sentEvents.map(sentEvent => sentEvent.message), [infoMessage]);
    assert.deepStrictEqual(hookCalls, [
        { level: 'error', event: errorMessage, extra: undefined },
        { level: 'info', event: infoMessage, extra: undefined }
    ]);
    assert.deepStrictEqual(replacementHookCalls, []);
}

// Client-only: one more Sentry.init on the server trips Node's listener limit, and Meteor's warning
// shim then throws from the init itself. Even the rejection case needs its own init with this file's
// hook, which no other server init can share.
(Meteor.isClient ? describe : describe.skip)(`wolas:sentry re-init on the ${environment}`, function() {
    beforeEach(function() {
        sentEvents.length = 0;
        hookCalls.length = 0;
        replacementHookCalls.length = 0;
    });

    describe('after an init that enables only info', function() {
        before(function() {
            init({ levels: ['info'] });
        });

        it('a rejected init leaves the previous levels and hook in place', async function() {
            assert.throws(() => Logger.init({ dsn, levels: ['warn'], postprocess: replacementHook }), /unknown levels/);
            await assertOnlyInfoEnabled('unknown');

            assert.throws(() => Logger.init({ dsn, levels: 'error', postprocess: replacementHook }), /must be an array/);
            await assertOnlyInfoEnabled('not-array');

            assert.throws(() => Logger.init(null), TypeError);
            await assertOnlyInfoEnabled('null');
        });

        // Last in its block on purpose: it re-inits with the defaults.
        it('a later init without levels restores the default set', async function() {
            init();

            const captured = nextEvent();
            const eventId = Logger.error('reinit defaults: error');
            const event = await captured;

            assert.strictEqual(typeof eventId, 'string');
            assert.strictEqual(event.message, 'reinit defaults: error');

            assert.strictEqual(Logger.info('reinit defaults: info'), undefined);

            // Had the info been queued, it would reach beforeSend before this.
            const sentinel = nextEvent();
            Logger.error('reinit defaults: sentinel');
            await sentinel;

            assert.deepStrictEqual(sentEvents.map(sentEvent => sentEvent.message), [
                'reinit defaults: error',
                'reinit defaults: sentinel'
            ]);
            assert.deepStrictEqual(hookCalls.find(call => call.level === 'info'), {
                level: 'info',
                event: 'reinit defaults: info',
                extra: undefined
            });
        });
    });

    describe('with an empty levels list', function() {
        before(function() {
            init({ levels: [] });
        });

        it('sends nothing and still postprocesses every level', async function() {
            SeverityLevels.forEach(level => {
                assert.strictEqual(Logger[level](`reinit empty: ${level}`), undefined);
            });

            await yieldMacrotask();

            assert.deepStrictEqual(sentEvents, []);
            assert.deepStrictEqual(hookCalls.map(call => call.level), SeverityLevels);
        });
    });

    describe('without a postprocess of its own', function() {
        it('a later init that leaves postprocess out stops calling the earlier hook', async function() {
            init();
            Logger.info('reinit hook: before');
            assert.strictEqual(hookCalls.length, 1);

            Logger.init({ dsn, beforeSend: () => null });
            Logger.error('reinit hook: after');
            Logger.info('reinit hook: after, not sent');

            assert.deepStrictEqual(hookCalls.map(call => call.event), ['reinit hook: before']);
        });
    });

    describe('with a non-function postprocess', function() {
        it('ignores it without throwing, keeps logging and stops calling the earlier hook', async function() {
            for(const value of ['not a function', null]) {
                hookCalls.length = 0;
                assert.doesNotThrow(() => init({ postprocess: value }));

                let eventId;
                const message = `reinit ${String(value)} hook`;
                // A hook failure is caught and reported on console.error, so silence is the proof none ran.
                const consoleErrorCalls = await withSilentConsoleError(async () => {
                    const captured = nextEvent();
                    eventId = Logger.error(message);
                    const event = await captured;
                    assert.strictEqual(event.message, message);
                });

                assert.strictEqual(typeof eventId, 'string');
                assert.deepStrictEqual(consoleErrorCalls, []);
                assert.deepStrictEqual(hookCalls, []);
            }
        });
    });
});
