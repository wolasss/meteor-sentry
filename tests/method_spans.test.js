import { Meteor } from 'meteor/meteor';
import { DDP } from 'meteor/ddp';
import assert from 'assert';
import Logger from 'meteor/wolas:sentry';
import {
    logged,
    nextEvent,
    transactionsDuring,
    methodTransactions
} from './harness.js';

(Meteor.isServer ? describe : describe.skip)('traceMethods on the server', function() {
    // Runs under the default levels' init, which turned on both captureMethodErrors and traceMethods.
    const thrownError = new Error('thrown from a traced method');
    const caller = { name: 'outer', userId: 'user-1', connection: null, setUserId() {}, randomSeed: 'wolas-sentry-test' };

    before(function() {
        Meteor.methods({
            'wolas-sentry-test.span.sync'(value) {
                return { value };
            },
            async 'wolas-sentry-test.span.async'() {
                await new Promise(resolve => setTimeout(resolve, 0));
                return 'async';
            },
            'wolas-sentry-test.span.throws'() {
                throw thrownError;
            }
        });
        // The path validated-method and allow/deny register through.
        Meteor.server.methods({
            'wolas-sentry-test.span.server'() {
                return 'server';
            }
        });
    });

    function callAs(invocation, name, ...args) {
        return DDP._CurrentMethodInvocation.withValue(invocation, () => Meteor.callAsync(name, ...args));
    }

    function callAsCaller(name, ...args) {
        return callAs(caller, name, ...args);
    }

    async function onlyMethodTransaction(action) {
        const transactions = methodTransactions(await transactionsDuring(action));

        assert.strictEqual(transactions.length, 1, `expected one meteor.method transaction, got ${transactions.length}`);

        return transactions[0];
    }

    function assertMethodTransaction(transaction, name) {
        assert.strictEqual(transaction.type, 'transaction');
        assert.strictEqual(transaction.transaction, name);
        assert.strictEqual(transaction.contexts.trace.op, 'meteor.method');
        assert.strictEqual(transaction.tags['meteor.method'], name);
    }

    [
        ['wolas-sentry-test.ping.call', 'registered before init'],
        ['wolas-sentry-test.span.sync', 'registered after init'],
        ['wolas-sentry-test.span.async', 'registered after init and async'],
        ['wolas-sentry-test.span.server', 'registered on Meteor.server after init']
    ].forEach(([name, registration]) => {
        it(`sends one transaction named after a method ${registration}, with its tag and user`, async function() {
            const transaction = await onlyMethodTransaction(() => callAsCaller(name));

            assertMethodTransaction(transaction, name);
            assert.strictEqual(transaction.user.id, 'user-1');
        });
    });

    it('never records the method\'s arguments', async function() {
        const transaction = await onlyMethodTransaction(() => callAsCaller('wolas-sentry-test.span.sync', 'secret argument'));

        // sdkProcessingMetadata is the SDK's own and never sent; it holds circular objects.
        const { sdkProcessingMetadata, ...sent } = transaction;

        assert.strictEqual(JSON.stringify(sent).includes('secret argument'), false);
    });

    it('does not carry a user from an earlier call onto a call without one', async function() {
        await onlyMethodTransaction(() => callAsCaller('wolas-sentry-test.span.sync'));

        const anonymous = await onlyMethodTransaction(() =>
            callAs({ ...caller, userId: null }, 'wolas-sentry-test.span.sync'));

        assertMethodTransaction(anonymous, 'wolas-sentry-test.span.sync');
        assert.strictEqual(anonymous.user?.id, undefined);
    });

    it('does not take a user from the isolation scope it runs in', async function() {
        const transaction = await onlyMethodTransaction(() => Logger.Sentry.withIsolationScope(isolation => {
            isolation.setUser({ id: 'someone-else' });
            return Meteor.server.method_handlers['wolas-sentry-test.span.sync'].call({ userId: null }, 1);
        }));

        assert.strictEqual(transaction.user?.id, undefined);
    });

    it('leaves no method tag or user on an event logged after the call', async function() {
        await onlyMethodTransaction(() => callAsCaller('wolas-sentry-test.span.sync'));

        const { event } = await logged('error');

        assert.strictEqual(event.tags['meteor.method'], undefined);
        assert.strictEqual(event.user?.id, undefined);
    });

    it('is its own transaction inside another span, with that span as its parent', async function() {
        let outerSpan;
        const transaction = await onlyMethodTransaction(() => Logger.Sentry.startSpan({ name: 'outer' }, span => {
            outerSpan = span;
            return callAsCaller('wolas-sentry-test.span.sync');
        }));

        assertMethodTransaction(transaction, 'wolas-sentry-test.span.sync');
        assert.strictEqual(transaction.contexts.trace.parent_span_id, outerSpan.spanContext().spanId);
        assert.strictEqual(transaction.contexts.trace.trace_id, outerSpan.spanContext().traceId);
    });

    it('keeps a sync handler sync', async function() {
        let result;
        const transaction = await onlyMethodTransaction(() => {
            result = Meteor.server.method_handlers['wolas-sentry-test.span.sync'].call({ userId: 'u' }, 3);
        });

        assert.deepStrictEqual(result, { value: 3 });
        assert.strictEqual(typeof result.then, 'undefined');
        assertMethodTransaction(transaction, 'wolas-sentry-test.span.sync');
        assert.strictEqual(transaction.user.id, 'u');
    });

    it('reports a thrown error once, rethrows it as is and ends the span with an error status', async function() {
        let reported;
        const transaction = await onlyMethodTransaction(async () => {
            const captured = nextEvent();
            await assert.rejects(callAsCaller('wolas-sentry-test.span.throws'), thrown => thrown === thrownError);
            reported = await captured;
        });

        assert.strictEqual(reported.exception.values[0].value, thrownError.message);
        assert.strictEqual(reported.tags['meteor.method'], 'wolas-sentry-test.span.throws');
        assertMethodTransaction(transaction, 'wolas-sentry-test.span.throws');
        assert.strictEqual(transaction.contexts.trace.status, 'internal_error');
    });
});
