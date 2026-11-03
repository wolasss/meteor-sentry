import { Meteor } from 'meteor/meteor';
import assert from 'assert';
import Logger from 'meteor/wolas:sentry';
import {
    initLogger,
    logged,
    nextTransaction,
    sentryClient,
    transactionsDuring,
    methodTransactions,
    fakeMeteorUser
} from './harness.js';
import {
    pingMethods,
    connectionApplyBeforeInit,
    connectionApplyAsyncBeforeInit,
    applyBeforeInit,
    applyAsyncBeforeInit
} from './before_init.js';

(Meteor.isClient ? describe : describe.skip)('traceMethods on the client', function() {
    const [callName, callAsyncName, applyName, applyAsyncName] = pingMethods;
    const deniedMethod = 'wolas-sentry-test.before.denied';
    const throwingStub = 'wolas-sentry-test.client.stub-throws';
    const stubError = new Error('thrown from a client stub');
    let user;

    before(function() {
        // A stub only: with throwStubExceptions the call never reaches the server.
        Meteor.methods({
            [throwingStub]() {
                throw stubError;
            }
        });
        user = fakeMeteorUser();
        initLogger({ traceMethods: true });
    });

    after(function() {
        user.set(null);
        user.restore();
        initLogger();
    });

    function callWithCallback(name, ...args) {
        return new Promise(resolve => {
            Meteor.call(name, ...args, (error, result) => resolve({ error, result }));
        });
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

    async function methodBreadcrumbCount() {
        const { event } = await logged('error');
        return (event.breadcrumbs || []).filter(breadcrumb => breadcrumb.category === 'meteor.method').length;
    }

    [
        [callName, () => callWithCallback(callName, 'secret')],
        [callAsyncName, () => Meteor.callAsync(callAsyncName, 'secret')],
        [applyName, () => Meteor.apply(applyName, ['secret'])],
        [applyAsyncName, () => Meteor.applyAsync(applyAsyncName, ['secret'])]
    ].forEach(([name, call]) => {
        it(`sends one transaction for ${name.split('.').pop()}, named and tagged after the method, without its arguments`, async function() {
            const transaction = await onlyMethodTransaction(call);

            assertMethodTransaction(transaction, name);

            // sdkProcessingMetadata is the SDK's own and never sent; it holds circular objects.
            const { sdkProcessingMetadata, ...sent } = transaction;

            assert.strictEqual(JSON.stringify(sent).includes('secret'), false);
        });
    });

    it('keeps traceMethods out of the Sentry options', function() {
        assert.strictEqual('traceMethods' in sentryClient().getOptions(), false);
    });

    it('leaves no method tag on an event logged after the call', async function() {
        await onlyMethodTransaction(() => Meteor.callAsync(callAsyncName));

        const { event } = await logged('error');

        assert.strictEqual(event.tags?.['meteor.method'], undefined);
    });

    it('carries the user trackUsers set, and none after logout', async function() {
        user.set({ emails: [{ address: 'traced@example.com' }] });
        const signedIn = await onlyMethodTransaction(() => Meteor.callAsync(callAsyncName));

        assert.strictEqual(signedIn.user.email, 'traced@example.com');

        user.set(null);
        const signedOut = await onlyMethodTransaction(() => Meteor.callAsync(callAsyncName));

        assert.strictEqual(signedOut.user?.email, undefined);
    });

    it('returns the very promise Meteor returned, with its stubPromise and serverPromise', async function() {
        const returned = [];

        // Restores the originals, so the next init wraps the recording wrapper below.
        initLogger({ traceMethods: false, methodBreadcrumbs: false });
        const originalApplyAsync = Meteor.connection.applyAsync;
        Meteor.connection.applyAsync = function(...args) {
            const promise = originalApplyAsync.apply(this, args);
            returned.push(promise);
            return promise;
        };

        try {
            initLogger({ traceMethods: true });

            let promise;
            const transaction = await onlyMethodTransaction(async () => {
                promise = Meteor.callAsync(callAsyncName);

                assert.strictEqual(returned.length, 1);
                assert.strictEqual(promise, returned[0]);
                assert.strictEqual(typeof promise.stubPromise.then, 'function');
                assert.strictEqual(typeof promise.serverPromise.then, 'function');

                await Promise.all([promise, promise.stubPromise, promise.serverPromise]);
            });

            assertMethodTransaction(transaction, callAsyncName);
        } finally {
            initLogger({ traceMethods: false, methodBreadcrumbs: false });
            Meteor.connection.applyAsync = originalApplyAsync;
            initLogger({ traceMethods: true });
        }
    });

    it('ends a call with a callback when the callback fires, not when apply returns', async function() {
        let sentBeforeReturn;
        let sentBeforeCallback;
        let transactionSent = false;
        const sent = nextTransaction(event => {
            transactionSent = event.transaction === applyName;
            return transactionSent;
        });

        await new Promise(resolve => {
            Meteor.apply(applyName, ['secret'], () => {
                sentBeforeCallback = transactionSent;
                resolve();
            }, undefined);
            sentBeforeReturn = transactionSent;
        });

        assertMethodTransaction(await sent, applyName);
        assert.strictEqual(sentBeforeReturn, false);
        // Sentry processes a transaction as its span ends, and the span ends just before the callback runs.
        assert.strictEqual(sentBeforeCallback, true);
    });

    it('marks a rejected callAsync failed and rejects with the same error', async function() {
        let promise;
        const transaction = await onlyMethodTransaction(async () => {
            promise = Meteor.callAsync(deniedMethod);
            await assert.rejects(promise, thrown => thrown.error === 'denied');
        });

        assertMethodTransaction(transaction, deniedMethod);
        assert.strictEqual(transaction.contexts.trace.status, 'internal_error');
    });

    it('marks a failed call with a callback failed and hands the callback the error', async function() {
        let outcome;
        const transaction = await onlyMethodTransaction(async () => {
            outcome = await callWithCallback(deniedMethod);
        });

        assert.strictEqual(outcome.error.error, 'denied');
        assertMethodTransaction(transaction, deniedMethod);
        assert.strictEqual(transaction.contexts.trace.status, 'internal_error');
    });

    it('ends an applyAsync with a callback when the callback fires, failed when it gets an error', async function() {
        let outcome;
        let resolved;
        const transaction = await onlyMethodTransaction(async () => {
            outcome = await new Promise(resolve => {
                resolved = Meteor.applyAsync(deniedMethod, [], {}, error => resolve({ error }));
            });
            await resolved;
        });

        assert.strictEqual(outcome.error.error, 'denied');
        assertMethodTransaction(transaction, deniedMethod);
        assert.strictEqual(transaction.contexts.trace.status, 'internal_error');
    });

    it('marks a stub that throws failed and throws the same value', async function() {
        const transaction = await onlyMethodTransaction(() => {
            assert.throws(() => Meteor.apply(throwingStub, [], { throwStubExceptions: true }), thrown => thrown === stubError);
        });

        assertMethodTransaction(transaction, throwingStub);
        assert.strictEqual(transaction.contexts.trace.status, 'internal_error');
    });

    it('is its own transaction inside another span, with that span as its parent', async function() {
        let outerSpan;
        const transaction = await onlyMethodTransaction(() => Logger.Sentry.startSpan({ name: 'outer' }, span => {
            outerSpan = span;
            return Meteor.callAsync(callAsyncName);
        }));

        assertMethodTransaction(transaction, callAsyncName);
        assert.strictEqual(transaction.contexts.trace.parent_span_id, outerSpan.spanContext().spanId);
    });

    it('sends no transaction with breadcrumbs alone, also after a later init turned traceMethods off', async function() {
        initLogger({ methodBreadcrumbs: true });
        const countBefore = await methodBreadcrumbCount();

        const transactions = methodTransactions(await transactionsDuring(() => Meteor.callAsync(callAsyncName)));

        assert.strictEqual(transactions.length, 0);
        assert.strictEqual(await methodBreadcrumbCount(), countBefore + 1);
    });

    it('sends a transaction and no breadcrumb with traceMethods alone', async function() {
        initLogger({ traceMethods: true, methodBreadcrumbs: false });
        const countBefore = await methodBreadcrumbCount();

        await onlyMethodTransaction(() => Meteor.callAsync(callAsyncName));

        assert.strictEqual(await methodBreadcrumbCount(), countBefore);
    });

    it('restores the connection and Meteor when both are off', function() {
        initLogger({ traceMethods: false, methodBreadcrumbs: false });

        assert.strictEqual(Meteor.connection.apply, connectionApplyBeforeInit, 'Meteor.connection.apply');
        assert.strictEqual(Meteor.connection.applyAsync, connectionApplyAsyncBeforeInit, 'Meteor.connection.applyAsync');
        assert.strictEqual(Meteor.apply, applyBeforeInit, 'Meteor.apply');
        assert.strictEqual(Meteor.applyAsync, applyAsyncBeforeInit, 'Meteor.applyAsync');
    });
});
