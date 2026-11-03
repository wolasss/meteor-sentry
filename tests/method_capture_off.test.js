import { Meteor } from 'meteor/meteor';
import { DDP } from 'meteor/ddp';
import assert from 'assert';
import {
    eventsDuring,
    transactionsDuring,
    methodTransactions
} from './harness.js';

(Meteor.isServer ? describe : describe.skip)('captureMethodErrors turned off by a later init', function() {
    // Runs under its own init: captureMethodErrors off after an init that had it on, traceMethods back on.
    const thrownError = new Error('thrown with capture off');
    const caller = { name: 'outer', userId: 'user-1', connection: null, setUserId() {}, randomSeed: 'wolas-sentry-test' };

    before(function() {
        Meteor.methods({
            'wolas-sentry-test.capture-off.sync'() {
                return 'sync';
            },
            'wolas-sentry-test.capture-off.throws'() {
                throw thrownError;
            }
        });
    });

    function callAsCaller(name) {
        return DDP._CurrentMethodInvocation.withValue(caller, () => Meteor.callAsync(name));
    }

    it('sends a transaction again once a later init turns traceMethods back on', async function() {
        const transactions = methodTransactions(await transactionsDuring(() => callAsCaller('wolas-sentry-test.capture-off.sync')));

        assert.strictEqual(transactions.length, 1);
        assert.strictEqual(transactions[0].transaction, 'wolas-sentry-test.capture-off.sync');
        assert.strictEqual(transactions[0].tags['meteor.method'], 'wolas-sentry-test.capture-off.sync');
        assert.strictEqual(transactions[0].user.id, 'user-1');
    });

    it('reports no thrown error, rethrows it as is and still ends the span with an error status', async function() {
        let transactions;
        const events = await eventsDuring(async () => {
            transactions = methodTransactions(await transactionsDuring(() =>
                assert.rejects(callAsCaller('wolas-sentry-test.capture-off.throws'), thrown => thrown === thrownError)));
        });

        assert.deepStrictEqual(events, []);
        assert.strictEqual(transactions.length, 1);
        assert.strictEqual(transactions[0].contexts.trace.status, 'internal_error');
    });
});
