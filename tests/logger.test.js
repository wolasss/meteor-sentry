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
let postprocessError;
let postprocessRejection;

// Registered before any init, so captureMethodErrors has to wrap them in place.
const methodsBeforeInit = Meteor.methods;
const serverMethodsBeforeInit = Meteor.isServer ? Meteor.server.methods : undefined;
const syncErrorBeforeInit = new Error('sync before init');
const asyncErrorBeforeInit = new Error('async before init');
const connectionApplyBeforeInit = Meteor.isClient ? Meteor.connection.apply : undefined;
const connectionApplyAsyncBeforeInit = Meteor.isClient ? Meteor.connection.applyAsync : undefined;
const pingMethods = ['call', 'callAsync', 'apply', 'applyAsync'].map(alias => `wolas-sentry-test.ping.${alias}`);
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
        },
        ...Object.fromEntries(pingMethods.map(name => [name, () => {}]))
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

            if(postprocessError) {
                throw postprocessError;
            }

            if(postprocessRejection) {
                return Promise.reject(postprocessRejection);
            }
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
            assert.strictEqual(Meteor.server.methods, serverMethodsBeforeInit);
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

        describe('postprocess hook isolation', function() {
            const originalConsoleError = console.error;
            let consoleErrorCalls;

            beforeEach(function() {
                consoleErrorCalls = [];
                console.error = (...args) => consoleErrorCalls.push(args);
            });

            afterEach(function() {
                console.error = originalConsoleError;
                postprocessError = undefined;
                postprocessRejection = undefined;
            });

            it('contains a throwing hook and still returns the event id', async function() {
                postprocessError = new Error('hook failed');
                postprocessCalls.length = 0;
                const captured = nextEvent();
                const eventId = Logger.error('hook throws', { a: 1 });
                const event = await captured;

                assert.strictEqual(typeof eventId, 'string');
                assert.strictEqual(event.message, 'hook throws');
                assert.strictEqual(postprocessCalls.length, 1);
                assert.strictEqual(consoleErrorCalls.length, 1);
                assert.ok(consoleErrorCalls[0].includes(postprocessError));
            });

            it('contains an async hook that rejects', async function() {
                postprocessRejection = new Error('async hook failed');
                const captured = nextEvent();
                const eventId = Logger.error('async hook rejects');
                await captured;
                await new Promise(resolve => setTimeout(resolve, 0));

                assert.strictEqual(typeof eventId, 'string');
                assert.strictEqual(consoleErrorCalls.length, 1);
                assert.ok(consoleErrorCalls[0].includes(postprocessRejection));
            });

            it('keeps calling the hook after it threw', function() {
                postprocessCalls.length = 0;
                Logger.warning('after hook threw', { attempt: 2 });

                assert.deepStrictEqual(postprocessCalls, [
                    { level: 'warning', event: 'after hook threw', extra: { attempt: 2 } }
                ]);
                assert.strictEqual(consoleErrorCalls.length, 0);
            });

            it('rejects a missing or non-object options argument', async function() {
                assert.throws(() => Logger.init(), { name: 'TypeError', message: /Logger\.init/ });
                [null, dsn].forEach(value => {
                    assert.throws(() => Logger.init(value), { name: 'TypeError', message: /Logger\.init/ });
                });

                postprocessCalls.length = 0;
                const captured = nextEvent();
                Logger.error('after rejected init');
                const event = await captured;

                assert.strictEqual(postprocessCalls[0].event, 'after rejected init');
                assert.strictEqual(event.message, 'after rejected init');
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
            const serverErrorAfterInit = new Error('sync after init on Meteor.server');
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
                    'wolas-sentry-test.after.client-safe'() {
                        throw Object.assign(new Error('client safe'), { isClientSafe: true, error: 'denied' });
                    },
                    'wolas-sentry-test.after.echo'(...args) {
                        return { name: this.name, userId: this.userId, args };
                    },
                    'wolas-sentry-test.after.throws'(error) {
                        throw error;
                    }
                });
                // The path validated-method and allow/deny register through.
                Meteor.server.methods({
                    'wolas-sentry-test.server.sync'() {
                        throw serverErrorAfterInit;
                    }
                });
            });

            function callAsCaller(name, ...args) {
                return DDP._CurrentMethodInvocation.withValue(caller, () => Meteor.callAsync(name, ...args));
            }

            let sentinels = 0;

            // A sentinel sent after the method proves nothing else was queued.
            // Each is unique, or Sentry's dedupe integration drops repeats.
            // An exception event is still being processed (its source context is
            // read async) when a message sent after it is done, so flush first.
            async function eventsAfter(action) {
                sentEvents.length = 0;
                await action();
                assert.strictEqual(await initResult.flush(2000), true);
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
                ['an async rejection', 'wolas-sentry-test.after.async', asyncErrorAfterInit, 'registered after init'],
                ['a sync throw', 'wolas-sentry-test.server.sync', serverErrorAfterInit, 'registered on Meteor.server after init']
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

            ['wolas-sentry-test.before.denied', 'wolas-sentry-test.after.denied', 'wolas-sentry-test.after.client-safe'].forEach(name => {
                it(`does not report a client-safe error from ${name}`, async function() {
                    const events = await eventsAfter(() =>
                        assert.rejects(callAsCaller(name), thrown => thrown.isClientSafe && thrown.error === 'denied'));

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
                assert.throws(() => Meteor.server.methods({ 'wolas-sentry-test.server.sync'() {} }), /already defined/);
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

    (Meteor.isClient ? describe : describe.skip)('method breadcrumbs and client options', function() {
        const originalUser = Meteor.user;
        let messages = 0;

        // Each message is unique, or Sentry's dedupe integration drops repeats.
        async function methodBreadcrumbsOnNextEvent() {
            const captured = nextEvent();
            messages += 1;
            Logger.error(`breadcrumbs check ${messages}`);
            const event = await captured;
            return (event.breadcrumbs || []).filter(breadcrumb => breadcrumb.category === 'meteor.method');
        }

        before(function() {
            initLogger();
        });

        after(function() {
            if(originalUser === undefined) {
                delete Meteor.user;
            } else {
                Meteor.user = originalUser;
            }
        });

        it('adds a breadcrumb named after each method call, without its arguments', async function() {
            const [callName, callAsyncName, applyName, applyAsyncName] = pingMethods;

            Meteor.call(callName, 'secret');
            await Meteor.callAsync(callAsyncName, 'secret');
            Meteor.apply(applyName, ['secret']);
            await Meteor.applyAsync(applyAsyncName, ['secret']);

            const breadcrumbs = (await methodBreadcrumbsOnNextEvent()).slice(-4);

            assert.deepStrictEqual(breadcrumbs.map(breadcrumb => breadcrumb.message), pingMethods);
            breadcrumbs.forEach(breadcrumb => {
                assert.strictEqual(breadcrumb.level, 'info');
                assert.strictEqual(breadcrumb.data, undefined);
            });
        });

        it('adds one breadcrumb per call after a second init', async function() {
            const countBefore = (await methodBreadcrumbsOnNextEvent()).length;

            initLogger();
            Meteor.call(pingMethods[0]);

            assert.strictEqual((await methodBreadcrumbsOnNextEvent()).length, countBefore + 1);
        });

        it('restores the connection when methodBreadcrumbs is false, and keeps the options out of Sentry', async function() {
            const options = initLogger({ methodBreadcrumbs: false, trackUsers: false }).getOptions();

            ['methodBreadcrumbs', 'trackUsers', 'postprocess', 'levels'].forEach(name => {
                assert.strictEqual(name in options, false, name);
            });
            assert.strictEqual(Meteor.connection.apply, connectionApplyBeforeInit);
            assert.strictEqual(Meteor.connection.applyAsync, connectionApplyAsyncBeforeInit);

            const countBefore = (await methodBreadcrumbsOnNextEvent()).length;
            Meteor.call(pingMethods[0]);

            assert.strictEqual((await methodBreadcrumbsOnNextEvent()).length, countBefore);
        });

        it('keeps a wrapper the app put on Meteor.apply, and restores it', async function() {
            const appWrapped = [];
            const applyBeforeWrapper = Meteor.apply;
            const appWrapper = function(name, ...rest) {
                appWrapped.push(name);
                return applyBeforeWrapper.call(this, name, ...rest);
            };
            Meteor.apply = appWrapper;

            try {
                initLogger();
                const countBefore = (await methodBreadcrumbsOnNextEvent()).length;
                Meteor.apply(pingMethods[2], []);

                assert.deepStrictEqual(appWrapped, [pingMethods[2]]);
                assert.strictEqual((await methodBreadcrumbsOnNextEvent()).length, countBefore + 1);

                initLogger({ methodBreadcrumbs: false });
                assert.strictEqual(Meteor.apply, appWrapper);
            } finally {
                initLogger({ methodBreadcrumbs: false });
                Meteor.apply = applyBeforeWrapper;
            }
        });

        it('stops tracking the user when a later init turns trackUsers off', async function() {
            const dependency = new Tracker.Dependency();
            let currentUser = { emails: [{ address: 'tracked@example.com' }] };

            Meteor.user = () => {
                dependency.depend();
                return currentUser;
            };
            initLogger();
            initLogger({ trackUsers: false });

            currentUser = { emails: [{ address: 'after-opt-out@example.com' }] };
            dependency.changed();
            Tracker.flush();

            const captured = nextEvent();
            Logger.error('after trackUsers was turned off');
            assert.strictEqual((await captured).user?.email, undefined);
        });

        it('does not track the user when trackUsers is false', async function() {
            const dependency = new Tracker.Dependency();
            let currentUser = null;

            Meteor.user = () => {
                dependency.depend();
                return currentUser;
            };
            initLogger({ trackUsers: false });

            currentUser = { emails: [{ address: 'untracked@example.com' }] };
            dependency.changed();
            Tracker.flush();

            const captured = nextEvent();
            Logger.error('with trackUsers off');
            assert.strictEqual((await captured).user?.email, undefined);
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
