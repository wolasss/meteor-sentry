import { Meteor } from 'meteor/meteor';
import { DDP } from 'meteor/ddp';
import assert from 'assert';
import {
    nextEvent,
    eventsDuring,
    transactionsDuring,
    methodTransactions
} from './harness.js';

(Meteor.isServer ? describe : describe.skip)('traceMethods turned off by a later init', function() {
    // Runs under the custom levels' init: captureMethodErrors on, traceMethods omitted after an init that had it on.
    const thrownError = new Error('thrown with tracing off');
    const caller = { name: 'outer', userId: 'user-1', connection: null, setUserId() {}, randomSeed: 'wolas-sentry-test' };

    before(function() {
        Meteor.methods({
            'wolas-sentry-test.trace-off.sync'() {
                return 'sync';
            },
            'wolas-sentry-test.trace-off.throws'() {
                throw thrownError;
            }
        });
    });

    function callAsCaller(name) {
        return DDP._CurrentMethodInvocation.withValue(caller, () => Meteor.callAsync(name));
    }

    ['wolas-sentry-test.ping.call', 'wolas-sentry-test.trace-off.sync'].forEach(name => {
        it(`sends no transaction for ${name}`, async function() {
            const transactions = await transactionsDuring(() => callAsCaller(name));

            assert.deepStrictEqual(methodTransactions(transactions), []);
        });
    });

    it('still reports a thrown error once with its tag and user', async function() {
        const events = await eventsDuring(async () => {
            const captured = nextEvent();
            await assert.rejects(callAsCaller('wolas-sentry-test.trace-off.throws'), thrown => thrown === thrownError);
            await captured;
        }, 'info');

        assert.strictEqual(events.length, 1);
        assert.strictEqual(events[0].exception.values[0].value, thrownError.message);
        assert.deepStrictEqual(events[0].tags, { 'meteor.method': 'wolas-sentry-test.trace-off.throws' });
        assert.strictEqual(events[0].user.id, 'user-1');
    });
});
