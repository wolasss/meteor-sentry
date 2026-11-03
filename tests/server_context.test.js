import { Meteor } from 'meteor/meteor';
import { DDP } from 'meteor/ddp';
import assert from 'assert';
import {
    logged
} from './harness.js';

(Meteor.isServer ? describe : describe.skip)('tagging the current invocation on the server', function() {
    // Runs under the default levels' init: one more Sentry.init on the server trips Node's listener limit.

    function eventInside(environmentVariable, invocation, event, beforeLogging = async () => {}) {
        return environmentVariable.withValue(invocation, async () => {
            await beforeLogging();
            return (await logged('error', event)).event;
        });
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
        const { event } = await logged('error', 'outside any invocation');

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
        const { event } = await withoutVariable('_CurrentMethodInvocation', () => logged('error', 'without method invocation state'));

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
