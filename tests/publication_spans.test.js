import { Meteor } from 'meteor/meteor';
import { DDP } from 'meteor/ddp';
import assert from 'assert';
import {
    nextTransaction,
    transactionsDuring,
    publicationTransactions
} from './harness.js';
import { testPublication } from './before_init.js';

(Meteor.isServer ? describe : describe.skip)('tracePublications on the server', function() {
    // Runs under the default levels' init, which turned on tracePublications.
    const result = { marker: 'pub' };
    const thrownError = new Error('thrown from a traced publication');
    const universalName = 'meteor.publication (universal)';
    let seen;
    let universalHandler;
    let connection;

    before(function() {
        // Only ever called directly, never subscribed to.
        Meteor.publish('wolas-sentry-test.pub.sync', function(...args) {
            seen = { self: this, args };
            return result;
        });
        Meteor.publish('wolas-sentry-test.pub.async', async function(...args) {
            await new Promise(resolve => setTimeout(resolve, 0));
            seen = { self: this, args };
            return result;
        });
        Meteor.publish('wolas-sentry-test.pub.throws', function() {
            throw thrownError;
        });
        Meteor.server.publish({
            'wolas-sentry-test.pub.object'(...args) {
                seen = { self: this, args };
                return result;
            }
        });
        // Meteor runs a universal publication at once on every session, so it returns nothing
        // and readies, and records only a run this suite started.
        Meteor.publish(null, function() {
            if(this.wolasSentryTest) {
                seen = { self: this };
            }
            this.ready();
        });
        universalHandler = Meteor.server.universal_publish_handlers[Meteor.server.universal_publish_handlers.length - 1];
    });

    after(function() {
        // So it does not run on later sessions.
        const index = Meteor.server.universal_publish_handlers.indexOf(universalHandler);

        if(index !== -1) {
            Meteor.server.universal_publish_handlers.splice(index, 1);
        }

        if(connection) {
            connection.disconnect();
        }
    });

    beforeEach(function() {
        seen = undefined;
    });

    function subscription(overrides = {}) {
        return { _name: undefined, userId: 'user-1', wolasSentryTest: true, ready() {}, ...overrides };
    }

    function runAs(handler, sub, ...args) {
        return DDP._CurrentPublicationInvocation.withValue(sub, () => handler.call(sub, ...args));
    }

    function handlerOf(name) {
        return Meteor.server.publish_handlers[name];
    }

    async function onlyPublicationTransaction(action) {
        const transactions = publicationTransactions(await transactionsDuring(action));

        assert.strictEqual(transactions.length, 1, `expected one meteor.publication transaction, got ${transactions.length}`);

        return transactions[0];
    }

    function assertPublicationTransaction(transaction, name) {
        assert.strictEqual(transaction.type, 'transaction');
        assert.strictEqual(transaction.transaction, name);
        assert.strictEqual(transaction.contexts.trace.op, 'meteor.publication');
        assert.strictEqual(transaction.tags['meteor.publication'], name);
    }

    it('sends one transaction for a publication registered before init, with its tag and user', async function() {
        const transaction = await onlyPublicationTransaction(() =>
            runAs(handlerOf(testPublication), subscription({ _name: testPublication })));

        assertPublicationTransaction(transaction, testPublication);
        assert.strictEqual(transaction.user.id, 'user-1');
    });

    [
        ['wolas-sentry-test.pub.sync', 'registered after init'],
        ['wolas-sentry-test.pub.async', 'registered after init and async'],
        ['wolas-sentry-test.pub.object', 'registered on Meteor.server as an object']
    ].forEach(([name, registration]) => {
        it(`sends one transaction for a publication ${registration}, passing this and arguments through`, async function() {
            const sub = subscription({ _name: name });
            let returned;
            const transaction = await onlyPublicationTransaction(async () => {
                returned = await runAs(handlerOf(name), sub, 'first', 2);
            });

            assertPublicationTransaction(transaction, name);
            assert.strictEqual(transaction.user.id, 'user-1');
            assert.strictEqual(returned, result);
            assert.strictEqual(seen.self, sub);
            assert.deepStrictEqual(seen.args, ['first', 2]);
        });
    });

    it('keeps a sync handler sync and returns its value as is', async function() {
        let returned;
        const transaction = await onlyPublicationTransaction(() => {
            returned = runAs(handlerOf('wolas-sentry-test.pub.sync'), subscription());
        });

        assert.strictEqual(returned, result);
        assert.strictEqual(typeof returned.then, 'undefined');
        assertPublicationTransaction(transaction, 'wolas-sentry-test.pub.sync');
    });

    it('carries no user for a subscription without one', async function() {
        const transaction = await onlyPublicationTransaction(() =>
            runAs(handlerOf('wolas-sentry-test.pub.sync'), subscription({ userId: null })));

        assertPublicationTransaction(transaction, 'wolas-sentry-test.pub.sync');
        assert.strictEqual(transaction.user?.id, undefined);
    });

    it('rethrows a thrown error as is and ends the span with an error status', async function() {
        const transaction = await onlyPublicationTransaction(() => {
            assert.throws(() => runAs(handlerOf('wolas-sentry-test.pub.throws'), subscription()),
                thrown => thrown === thrownError);
        });

        assertPublicationTransaction(transaction, 'wolas-sentry-test.pub.throws');
        assert.strictEqual(transaction.contexts.trace.status, 'internal_error');
    });

    it('ignores a duplicate name, as Meteor does, keeping the first handler', function() {
        const handler = handlerOf('wolas-sentry-test.pub.sync');
        const debug = Meteor._debug;
        const logged = [];

        Meteor._debug = (...args) => logged.push(args);

        try {
            Meteor.publish('wolas-sentry-test.pub.sync', function() {});
        } finally {
            Meteor._debug = debug;
        }

        assert.strictEqual(handlerOf('wolas-sentry-test.pub.sync'), handler);
        assert.match(String(logged[0]), /Ignoring duplicate publish named 'wolas-sentry-test.pub.sync'/);
    });

    it('names a universal publication\'s transaction for it, with an attribute and no tag', async function() {
        const sub = subscription({ userId: 'universal-user' });
        const transactions = publicationTransactions(await transactionsDuring(() => runAs(universalHandler, sub)));
        // A real session starting meanwhile can add an anonymous run of its own.
        const ours = transactions.filter(event => event.transaction === universalName && event.user?.id === 'universal-user');

        assert.strictEqual(ours.length, 1);
        assert.strictEqual(ours[0].contexts.trace.op, 'meteor.publication');
        assert.strictEqual(ours[0].contexts.trace.data['meteor.publication.universal'], true);
        assert.strictEqual(ours[0].tags?.['meteor.publication'], undefined);
        assert.strictEqual(seen.self, sub);
    });

    it('sends a transaction for a real subscription over DDP', async function() {
        this.timeout(10000);

        const sent = nextTransaction(event => event.transaction === testPublication);

        connection = DDP.connect(Meteor.absoluteUrl());

        await new Promise((resolve, reject) => {
            connection.subscribe(testPublication, { onReady: resolve, onStop: reject });
        });

        const transaction = await sent;

        assertPublicationTransaction(transaction, testPublication);
        assert.strictEqual(transaction.user?.id, undefined);
    });
});
