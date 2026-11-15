import { Meteor } from 'meteor/meteor';
import { DDP } from 'meteor/ddp';
import assert from 'assert';
import {
    eventsDuring,
    transactionsDuring,
    methodTransactions,
    publicationTransactions
} from './harness.js';
import { testPublication } from './before_init.js';

// Server only. Each function makes its own init with the quietInit levels.test.js passes in.

const caller = { name: 'outer', userId: 'user-1', connection: null, setUserId() {}, randomSeed: 'wolas-sentry-test' };
const allOn = { captureMethodErrors: true, traceMethods: true, tracePublications: true };

function callAsCaller(name) {
    return DDP._CurrentMethodInvocation.withValue(caller, () => Meteor.callAsync(name));
}

function identities() {
    return {
        methods: Meteor.methods,
        serverMethods: Meteor.server.methods,
        methodHandler: Meteor.server.method_handlers['wolas-sentry-test.before.sync'],
        publish: Meteor.publish,
        serverPublish: Meteor.server.publish,
        publicationHandler: Meteor.server.publish_handlers[testPublication]
    };
}

// Every switch on again, after earlier inits already installed the wrappers.
export function describeReinitOn(quietInit) {
    const thrownError = new Error('thrown after a second install');
    let ahead;

    before(function() {
        ahead = identities();
        return quietInit(allOn);
    });

    it('wraps nothing twice', function() {
        assert.deepStrictEqual(identities(), ahead);
    });

    it('reports a throw from a method registered after it once, in one span', async function() {
        Meteor.methods({
            'wolas-sentry-test.reinit.throws'() {
                throw thrownError;
            }
        });

        let transactions;
        const events = await eventsDuring(async () => {
            transactions = methodTransactions(await transactionsDuring(() =>
                assert.rejects(callAsCaller('wolas-sentry-test.reinit.throws'), thrown => thrown === thrownError)));
        });

        assert.strictEqual(events.length, 1, `expected one error event, got ${events.length}`);
        assert.strictEqual(events[0].exception.values[0].value, thrownError.message);
        assert.strictEqual(transactions.length, 1, `expected one meteor.method transaction, got ${transactions.length}`);
    });

    it('installs nothing and throws nothing without Meteor\'s private registries', async function() {
        const methodHandlers = Meteor.server.method_handlers;
        const universalHandlers = Meteor.server.universal_publish_handlers;
        const ahead = identities();

        try {
            Meteor.server.method_handlers = undefined;
            Meteor.server.universal_publish_handlers = undefined;

            await assert.doesNotReject(quietInit(allOn));
        } finally {
            Meteor.server.method_handlers = methodHandlers;
            Meteor.server.universal_publish_handlers = universalHandlers;
            await quietInit(allOn);
        }

        assert.deepStrictEqual(identities(), ahead);
    });
}

// Every switch off after the wrappers are installed: each one only calls its handler through.
export function describeAllOff(quietInit) {
    const thrownError = new Error('thrown with every switch off');
    const publication = 'wolas-sentry-test.reinit.pub';

    before(async function() {
        await quietInit({ captureMethodErrors: false, traceMethods: false, tracePublications: false });
        Meteor.methods({
            'wolas-sentry-test.reinit.sync'(value) {
                return { value };
            },
            'wolas-sentry-test.reinit.off-throws'() {
                throw thrownError;
            }
        });
        Meteor.publish(publication, function() {
            return 'published';
        });
    });

    it('keeps a sync handler sync and sends nothing', async function() {
        let result;
        const transactions = await transactionsDuring(() => {
            result = Meteor.server.method_handlers['wolas-sentry-test.reinit.sync'].call({ userId: 'u' }, 4);
        });

        assert.deepStrictEqual(result, { value: 4 });
        assert.strictEqual(typeof result.then, 'undefined');
        assert.deepStrictEqual(methodTransactions(transactions), []);
    });

    it('rethrows the same value and reports nothing', async function() {
        let transactions;
        const events = await eventsDuring(async () => {
            transactions = await transactionsDuring(() => {
                assert.throws(() => Meteor.server.method_handlers['wolas-sentry-test.reinit.off-throws'].call({ userId: 'u' }),
                    thrown => thrown === thrownError);
            });
        });

        assert.deepStrictEqual(events, []);
        assert.deepStrictEqual(methodTransactions(transactions), []);
    });

    it('calls a publication through with no span', async function() {
        let result;
        const transactions = await transactionsDuring(() => {
            result = Meteor.server.publish_handlers[publication].call({ userId: 'u' });
        });

        assert.strictEqual(result, 'published');
        assert.deepStrictEqual(publicationTransactions(transactions), []);
    });
}
