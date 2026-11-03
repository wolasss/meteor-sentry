import { Meteor } from 'meteor/meteor';
import { DDP } from 'meteor/ddp';
import assert from 'assert';
import {
    nextEvent,
    eventsDuring
} from './harness.js';
import {
    syncErrorBeforeInit,
    asyncErrorBeforeInit
} from './before_init.js';

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
            const events = await eventsDuring(async () => {
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
            const events = await eventsDuring(() =>
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
