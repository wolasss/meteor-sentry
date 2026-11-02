import { Meteor } from 'meteor/meteor';
import { Tracker } from 'meteor/tracker';
import { DDP } from 'meteor/ddp';
import assert from 'assert';
import Logger from 'meteor/wolas:sentry';

const SeverityLevels = ['fatal', 'error', 'warning', 'log', 'info', 'debug', 'critical'];
const DefaultLevels = ['fatal', 'error', 'warning', 'critical'];
const SentryLevelAliases = { critical: 'fatal' };
const environment = Meteor.isClient ? 'client' : 'server';
const dsn = 'https://public@sentry.invalid/1';

let pendingEvent;
const sentEvents = [];
const postprocessCalls = [];

// Registered before any init, so captureMethodErrors has to wrap them in place.
const methodsBeforeInit = Meteor.methods;
const syncErrorBeforeInit = new Error('sync before init');
const asyncErrorBeforeInit = new Error('async before init');
const syncHandlerBeforeInit = function() {
    throw syncErrorBeforeInit;
};

if(Meteor.isServer) {
    Meteor.methods({
        'wolas-sentry-test.before.sync': syncHandlerBeforeInit,
        async 'wolas-sentry-test.before.async'() {
            throw asyncErrorBeforeInit;
        },
        'wolas-sentry-test.before.denied'() {
            throw new Meteor.Error('denied');
        }
    });
}

function nextEvent() {
    return new Promise(resolve => {
        pendingEvent = resolve;
    });
}

function initLogger(options = {}) {
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
            postprocessCalls.push({ level, event, extra });
        },
        ...options
    });
}

async function assertSent(level) {
    const captured = nextEvent();
    const eventId = Logger[level](`${level} message`, { orderId: 42 });
    const event = await captured;

    assert.strictEqual(typeof eventId, 'string');
    assert.strictEqual(event.event_id, eventId);
    assert.strictEqual(event.message, `${level} message`);
    assert.strictEqual(event.level, SentryLevelAliases[level] || level);
    assert.deepStrictEqual(event.extra, { orderId: 42 });
    assert.strictEqual(event.tags.key, environment);
}

// A message sent after the skipped one proves nothing was queued before it.
// Each sentinel is unique, or Sentry's dedupe integration drops repeats.
async function assertNotSent(level, event, sentinelLevel) {
    sentEvents.length = 0;
    postprocessCalls.length = 0;

    const sentinel = `sentinel after ${level}`;
    const eventId = Logger[level](event, { orderId: 42 });
    const captured = nextEvent();
    Logger[sentinelLevel](sentinel);
    await captured;

    assert.strictEqual(eventId, undefined);
    assert.deepStrictEqual(sentEvents.map(sentEvent => sentEvent.message), [sentinel]);
    assert.deepStrictEqual(postprocessCalls[0], { level, event, extra: { orderId: 42 } });
}

describe(`wolas:sentry on the ${environment}`, function() {
    describe('with every level enabled', function() {
        before(function() {
            initLogger({ levels: SeverityLevels });
        });

        it('exposes a method for every severity level', function() {
            SeverityLevels.forEach(level => {
                assert.strictEqual(typeof Logger[level], 'function', level);
            });
        });

        SeverityLevels.forEach(level => {
            it(`sends a ${level} message with its extra data and environment tag`, async function() {
                await assertSent(level);
            });
        });

        it('sends an Error as an exception with its level, extra data and environment tag', async function() {
            const captured = nextEvent();
            const eventId = Logger.warning(new Error('boom'), { orderId: 42 });
            const event = await captured;

            assert.strictEqual(event.event_id, eventId);
            assert.strictEqual(event.exception.values[0].type, 'Error');
            assert.strictEqual(event.exception.values[0].value, 'boom');
            assert.strictEqual(event.level, 'warning');
            assert.deepStrictEqual(event.extra, { orderId: 42 });
            assert.strictEqual(event.tags.key, environment);
        });

        it('sends critical as fatal but postprocesses it as critical', async function() {
            postprocessCalls.length = 0;
            const captured = nextEvent();
            Logger.critical('critical as fatal');
            const event = await captured;

            assert.strictEqual(event.level, 'fatal');
            assert.strictEqual(postprocessCalls[0].level, 'critical');
        });

        (Meteor.isServer ? it : it.skip)('leaves methods alone when captureMethodErrors is omitted', function() {
            assert.strictEqual(Meteor.methods, methodsBeforeInit);
            assert.strictEqual(Meteor.server.method_handlers['wolas-sentry-test.before.sync'], syncHandlerBeforeInit);
        });

        it('calls postprocess with the level, event and extra data', function() {
            postprocessCalls.length = 0;
            Logger.warning('postprocessed', { attempt: 2 });

            assert.deepStrictEqual(postprocessCalls, [
                { level: 'warning', event: 'postprocessed', extra: { attempt: 2 } }
            ]);
        });
    });

    describe('with the default levels', function() {
        let initResult;

        before(function() {
            initResult = initLogger(Meteor.isServer ? { captureMethodErrors: true } : {});
        });

        it('returns the Sentry client without the package options in it', function() {
            assert.strictEqual(typeof initResult.getOptions, 'function');

            const options = initResult.getOptions();

            ['captureMethodErrors', 'postprocess', 'levels'].forEach(name => {
                assert.strictEqual(name in options, false, name);
            });
        });

        DefaultLevels.forEach(level => {
            it(`sends a ${level} message`, async function() {
                await assertSent(level);
            });
        });

        SeverityLevels.filter(level => !DefaultLevels.includes(level)).forEach(level => {
            it(`does not send a ${level} message but still postprocesses it`, async function() {
                await assertNotSent(level, `${level} message`, 'error');
            });
        });

        (Meteor.isServer ? describe : describe.skip)('tagging the current invocation on the server', function() {
            // Runs under the default levels' init: one more Sentry.init on the server trips Node's listener limit.

            // Each message is unique, or Sentry's dedupe integration drops repeats.
            function eventInside(environmentVariable, invocation, event, beforeLogging = async () => {}) {
                return environmentVariable.withValue(invocation, async () => {
                    await beforeLogging();
                    const captured = nextEvent();
                    Logger.error(event);
                    return captured;
                });
            }

            async function eventOutside(event) {
                const captured = nextEvent();
                Logger.error(event);
                return captured;
            }

            async function crossAsyncBoundaries() {
                await new Promise(resolve => setTimeout(resolve, 0));
                await Promise.resolve();
            }

            async function withoutVariable(name, callback) {
                const original = DDP[name];
                DDP[name] = undefined;

                try {
                    return await callback();
                } finally {
                    DDP[name] = original;
                }
            }

            it('tags a message logged inside a method with its name and user', async function() {
                const event = await eventInside(DDP._CurrentMethodInvocation, { name: 'orders.create', userId: 'user-1' }, 'inside a method');

                assert.deepStrictEqual(event.tags, { key: 'server', 'meteor.method': 'orders.create' });
                assert.strictEqual(event.user.id, 'user-1');
            });

            it('tags an Error logged inside a method with its name and user', async function() {
                const event = await eventInside(DDP._CurrentMethodInvocation, { name: 'orders.create', userId: 'user-1' }, new Error('boom inside a method'));

                assert.strictEqual(event.exception.values[0].value, 'boom inside a method');
                assert.deepStrictEqual(event.tags, { key: 'server', 'meteor.method': 'orders.create' });
                assert.strictEqual(event.user.id, 'user-1');
            });

            it('tags a message logged inside a publication with its name and user', async function() {
                const event = await eventInside(DDP._CurrentPublicationInvocation, { _name: 'orders', userId: 'user-2' }, 'inside a publication');

                assert.deepStrictEqual(event.tags, { key: 'server', 'meteor.publication': 'orders' });
                assert.strictEqual(event.user.id, 'user-2');
            });

            it('sends no user id for a method called without a user', async function() {
                const event = await eventInside(DDP._CurrentMethodInvocation, { name: 'orders.list', userId: null }, 'inside an anonymous method');

                assert.deepStrictEqual(event.tags, { key: 'server', 'meteor.method': 'orders.list' });
                assert.strictEqual(event.user?.id, undefined);
            });

            it('sends no publication tag for a universal publication', async function() {
                const event = await eventInside(DDP._CurrentPublicationInvocation, { _name: undefined, userId: null }, 'inside a universal publication');

                assert.deepStrictEqual(event.tags, { key: 'server' });
                assert.strictEqual(event.user?.id, undefined);
            });

            it('sends only the environment tag outside any invocation', async function() {
                const event = await eventOutside('outside any invocation');

                assert.deepStrictEqual(event.tags, { key: 'server' });
                assert.strictEqual(event.user?.id, undefined);
            });

            it('keeps the method context across async boundaries', async function() {
                const event = await eventInside(DDP._CurrentMethodInvocation, { name: 'orders.await', userId: 'user-3' }, 'after awaiting in a method', crossAsyncBoundaries);

                assert.deepStrictEqual(event.tags, { key: 'server', 'meteor.method': 'orders.await' });
                assert.strictEqual(event.user.id, 'user-3');
            });

            it('keeps the publication context across async boundaries', async function() {
                const event = await eventInside(DDP._CurrentPublicationInvocation, { _name: 'orders.await', userId: 'user-4' }, 'after awaiting in a publication', crossAsyncBoundaries);

                assert.deepStrictEqual(event.tags, { key: 'server', 'meteor.publication': 'orders.await' });
                assert.strictEqual(event.user.id, 'user-4');
            });

            it('sends untagged events when Meteor has no method invocation state', async function() {
                const event = await withoutVariable('_CurrentMethodInvocation', () => eventOutside('without method invocation state'));

                assert.deepStrictEqual(event.tags, { key: 'server' });
                assert.strictEqual(event.user?.id, undefined);
            });

            it('still tags a method when Meteor has no publication invocation state', async function() {
                const methodInvocation = DDP._CurrentMethodInvocation;
                const event = await withoutVariable('_CurrentPublicationInvocation', () =>
                    eventInside(methodInvocation, { name: 'orders.fallback', userId: 'user-5' }, 'without publication invocation state'));

                assert.deepStrictEqual(event.tags, { key: 'server', 'meteor.method': 'orders.fallback' });
                assert.strictEqual(event.user.id, 'user-5');
            });
        });

        (Meteor.isServer ? describe : describe.skip)('captureMethodErrors on the server', function() {
            // Runs under the default levels' init, which turned the option on.
            const syncErrorAfterInit = new Error('sync after init');
            const asyncErrorAfterInit = new Error('async after init');
            const caller = { name: 'outer', userId: 'user-1', connection: null, setUserId() {}, randomSeed: 'wolas-sentry-test' };

            before(function() {
                Meteor.methods({
                    'wolas-sentry-test.after.sync'() {
                        throw syncErrorAfterInit;
                    },
                    async 'wolas-sentry-test.after.async'() {
                        throw asyncErrorAfterInit;
                    },
                    'wolas-sentry-test.after.denied'() {
                        throw new Meteor.Error('denied');
                    },
                    'wolas-sentry-test.after.echo'(...args) {
                        return { name: this.name, userId: this.userId, args };
                    },
                    'wolas-sentry-test.after.throws'(error) {
                        throw error;
                    }
                });
            });

            function callAsCaller(name, ...args) {
                return DDP._CurrentMethodInvocation.withValue(caller, () => Meteor.callAsync(name, ...args));
            }

            let sentinels = 0;

            // A sentinel sent after the method proves nothing else was queued.
            // Each is unique, or Sentry's dedupe integration drops repeats.
            async function eventsAfter(action) {
                sentEvents.length = 0;
                await action();
                const captured = nextEvent();
                sentinels += 1;
                Logger.error(`sentinel ${sentinels} after a method`);
                await captured;
                return sentEvents.slice(0, -1);
            }

            function assertReported(event, name, error) {
                assert.strictEqual(event.exception.values[0].value, error.message);
                assert.deepStrictEqual(event.tags, { 'meteor.method': name });
                assert.strictEqual(event.user.id, 'user-1');
                assert.strictEqual(event.exception.values[0].mechanism.type, 'meteor.method');
                assert.strictEqual(event.exception.values[0].mechanism.handled, false);
            }

            [
                ['a sync throw', 'wolas-sentry-test.before.sync', syncErrorBeforeInit, 'registered before init'],
                ['an async rejection', 'wolas-sentry-test.before.async', asyncErrorBeforeInit, 'registered before init'],
                ['a sync throw', 'wolas-sentry-test.after.sync', syncErrorAfterInit, 'registered after init'],
                ['an async rejection', 'wolas-sentry-test.after.async', asyncErrorAfterInit, 'registered after init']
            ].forEach(([kind, name, error, registration]) => {
                it(`reports ${kind} once from a method ${registration} and rethrows the same error`, async function() {
                    const events = await eventsAfter(async () => {
                        const captured = nextEvent();
                        await assert.rejects(callAsCaller(name), thrown => thrown === error);
                        await captured;
                    });

                    assert.strictEqual(events.length, 1);
                    assertReported(events[0], name, error);
                });
            });

            ['wolas-sentry-test.before.denied', 'wolas-sentry-test.after.denied'].forEach(name => {
                it(`does not report a Meteor.Error from ${name}`, async function() {
                    const events = await eventsAfter(() =>
                        assert.rejects(callAsCaller(name), thrown => thrown instanceof Meteor.Error && thrown.error === 'denied'));

                    assert.deepStrictEqual(events, []);
                });
            });

            it('passes the invocation and arguments through to the handler', async function() {
                const result = await callAsCaller('wolas-sentry-test.after.echo', 1, 'two');

                assert.deepStrictEqual(result, { name: 'wolas-sentry-test.after.echo', userId: 'user-1', args: [1, 'two'] });
            });

            it('keeps a sync handler sync', async function() {
                const result = Meteor.server.method_handlers['wolas-sentry-test.after.echo'].call({ name: 'direct', userId: 'u' }, 3);

                assert.deepStrictEqual(result, { name: 'direct', userId: 'u', args: [3] });
                assert.strictEqual(typeof result.then, 'undefined');

                const error = new Error('direct sync throw');
                const captured = nextEvent();
                assert.throws(() => Meteor.server.method_handlers['wolas-sentry-test.after.throws'].call({}, error), thrown => thrown === error);
                assert.strictEqual((await captured).exception.values[0].value, 'direct sync throw');
            });

            it('rethrows a thrown primitive as is', async function() {
                const captured = nextEvent();
                assert.throws(() => Meteor.server.method_handlers['wolas-sentry-test.after.throws'].call({}, 'primitive from a method'), thrown => thrown === 'primitive from a method');
                await captured;
            });

            it('keeps Meteor\'s own errors for a bad registration', function() {
                assert.throws(() => Meteor.methods({ 'wolas-sentry-test.after.echo'() {} }), /already defined/);
                assert.throws(() => Meteor.methods({ 'wolas-sentry-test.after.not-a-function': 42 }), /must be a function/);
            });
        });
    });

    describe('with custom levels', function() {
        before(function() {
            initLogger({ levels: ['info'] });
        });

        it('sends a listed level', async function() {
            await assertSent('info');
        });

        it('does not send an unlisted level, even for an Error', async function() {
            await assertNotSent('error', new Error('boom'), 'info');
        });
    });

    (Meteor.isClient ? describe : describe.skip)('tracking the Meteor user on the client', function() {
        const originalUser = Meteor.user;
        let dependency;
        let currentUser;

        function setCurrentUser(user) {
            currentUser = user;
            dependency.changed();
            Tracker.flush();
        }

        // Each message is unique, or Sentry's dedupe integration drops repeats.
        async function userOnNextEvent(message) {
            const captured = nextEvent();
            Logger.error(message);
            return (await captured).user;
        }

        before(function() {
            dependency = new Tracker.Dependency();
            currentUser = null;
            // accounts-base is not in the test app, and init only tracks users when Meteor.user exists.
            Meteor.user = () => {
                dependency.depend();
                return currentUser;
            };
            initLogger();
        });

        after(function() {
            if(originalUser === undefined) {
                delete Meteor.user;
            } else {
                Meteor.user = originalUser;
            }
        });

        it('clears the Sentry user on logout', async function() {
            setCurrentUser({ emails: [{ address: 'alice@example.com' }] });
            assert.strictEqual((await userOnNextEvent('logged in as alice')).email, 'alice@example.com');

            setCurrentUser(null);
            assert.strictEqual((await userOnNextEvent('after logout'))?.email, undefined);
        });

        it('clears the Sentry user when the next user has no email', async function() {
            setCurrentUser({ emails: [{ address: 'alice@example.com' }] });
            assert.strictEqual((await userOnNextEvent('logged in as alice again')).email, 'alice@example.com');

            setCurrentUser({ emails: [] });
            assert.strictEqual((await userOnNextEvent('logged in as bob without email'))?.email, undefined);
        });

        it('clears the Sentry user when the next user has no emails field', async function() {
            setCurrentUser({ emails: [{ address: 'alice@example.com' }] });
            assert.strictEqual((await userOnNextEvent('logged in as alice once more')).email, 'alice@example.com');

            setCurrentUser({ services: { github: {} } });
            assert.strictEqual((await userOnNextEvent('logged in as an OAuth-only user'))?.email, undefined);
        });
    });

    it('rejects unknown levels', function() {
        assert.throws(() => Logger.init({ dsn, levels: ['warn'] }), /unknown levels: warn/);
        assert.throws(() => Logger.init({ dsn, levels: 'error' }), /must be an array/);
    });
});
