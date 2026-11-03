import { Meteor } from 'meteor/meteor';
import assert from 'assert';
import {
    initLogger,
    logged
} from './harness.js';
import {
    testPublication,
    connectionSubscribeBeforeInit,
    subscribeBeforeInit
} from './before_init.js';

(Meteor.isClient ? describe : describe.skip)('subscription breadcrumbs', function() {
    const handles = [];

    async function subscriptionBreadcrumbsOnNextEvent() {
        const { event } = await logged('error');
        return (event.breadcrumbs || []).filter(breadcrumb => breadcrumb.category === 'meteor.subscription');
    }

    // A dropped callback fails the test instead of hanging it.
    function withinFiveSeconds(promise, what) {
        let timer;
        const timeout = new Promise((resolve, reject) => {
            timer = setTimeout(() => reject(new Error(`${what} never happened`)), 5000);
        });
        return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
    }

    function subscribe(...args) {
        const handle = Meteor.subscribe(...args);
        handles.push(handle);
        return handle;
    }

    before(function() {
        initLogger();
    });

    afterEach(function() {
        handles.splice(0).forEach(handle => handle.stop());
    });

    it('adds a breadcrumb named after each subscription, without its arguments', async function() {
        const countBefore = (await subscriptionBreadcrumbsOnNextEvent()).length;

        subscribe(testPublication, 'secret');
        const connectionHandle = Meteor.connection.subscribe(testPublication, 'secret');
        handles.push(connectionHandle);

        const breadcrumbs = await subscriptionBreadcrumbsOnNextEvent();

        assert.strictEqual(breadcrumbs.length, countBefore + 2);
        breadcrumbs.slice(-2).forEach(breadcrumb => {
            assert.strictEqual(breadcrumb.message, testPublication);
            assert.strictEqual(breadcrumb.level, 'info');
            assert.strictEqual(breadcrumb.data, undefined);
        });
        handles.forEach(handle => {
            assert.strictEqual(typeof handle.ready, 'function');
            assert.strictEqual(typeof handle.stop, 'function');
        });
    });

    it('passes the callbacks through unchanged', async function() {
        let onReady;
        let onStop;
        const ready = new Promise(resolve => {
            onReady = resolve;
        });
        const stopped = new Promise(resolve => {
            onStop = resolve;
        });
        const handle = subscribe(testPublication, 'secret', { onReady, onStop });

        await withinFiveSeconds(ready, 'onReady');
        handle.stop();
        await withinFiveSeconds(stopped, 'onStop');

        let onReadyShorthand;
        const readyShorthand = new Promise(resolve => {
            onReadyShorthand = resolve;
        });
        subscribe(testPublication, 'secret', onReadyShorthand);
        await withinFiveSeconds(readyShorthand, 'the onReady shorthand');
    });

    it('adds one breadcrumb per subscription after a second init', async function() {
        const countBefore = (await subscriptionBreadcrumbsOnNextEvent()).length;

        initLogger();
        subscribe(testPublication);

        assert.strictEqual((await subscriptionBreadcrumbsOnNextEvent()).length, countBefore + 1);
    });

    it('restores the connection when subscriptionBreadcrumbs is false, and keeps the option out of Sentry', async function() {
        const options = initLogger({ subscriptionBreadcrumbs: false }).getOptions();

        assert.strictEqual('subscriptionBreadcrumbs' in options, false);
        assert.strictEqual(Meteor.connection.subscribe, connectionSubscribeBeforeInit);
        assert.strictEqual(Meteor.subscribe, subscribeBeforeInit);

        const countBefore = (await subscriptionBreadcrumbsOnNextEvent()).length;
        subscribe(testPublication);

        assert.strictEqual((await subscriptionBreadcrumbsOnNextEvent()).length, countBefore);
    });

    it('keeps a wrapper the app put on Meteor.subscribe, and restores it', async function() {
        const appWrapped = [];
        const subscribeBeforeWrapper = Meteor.subscribe;
        const appWrapper = function(name, ...rest) {
            appWrapped.push(name);
            return subscribeBeforeWrapper.call(this, name, ...rest);
        };
        Meteor.subscribe = appWrapper;

        try {
            initLogger();
            const countBefore = (await subscriptionBreadcrumbsOnNextEvent()).length;
            subscribe(testPublication);

            assert.deepStrictEqual(appWrapped, [testPublication]);
            assert.strictEqual((await subscriptionBreadcrumbsOnNextEvent()).length, countBefore + 1);

            initLogger({ subscriptionBreadcrumbs: false });
            assert.strictEqual(Meteor.subscribe, appWrapper);
        } finally {
            initLogger({ subscriptionBreadcrumbs: false });
            Meteor.subscribe = subscribeBeforeWrapper;
        }
    });

    it('keeps a wrapper put on Meteor.subscribe after init when turned off, and stops adding breadcrumbs', async function() {
        const appWrapped = [];

        initLogger();
        const subscribeBeforeWrapper = Meteor.subscribe;
        const appWrapper = function(name, ...rest) {
            appWrapped.push(name);
            return subscribeBeforeWrapper.call(this, name, ...rest);
        };
        Meteor.subscribe = appWrapper;

        try {
            initLogger({ subscriptionBreadcrumbs: false });

            assert.strictEqual(Meteor.subscribe, appWrapper);
            assert.strictEqual(Meteor.connection.subscribe, connectionSubscribeBeforeInit);

            const countBefore = (await subscriptionBreadcrumbsOnNextEvent()).length;
            subscribe(testPublication);

            assert.deepStrictEqual(appWrapped, [testPublication]);
            assert.strictEqual((await subscriptionBreadcrumbsOnNextEvent()).length, countBefore);
        } finally {
            Meteor.subscribe = subscribeBeforeInit;
        }
    });

    it('installs nothing when the connection has no subscribe', function() {
        initLogger({ subscriptionBreadcrumbs: false });
        Meteor.connection.subscribe = undefined;

        try {
            assert.doesNotThrow(() => initLogger());
            assert.strictEqual(Meteor.subscribe, subscribeBeforeInit);
        } finally {
            Meteor.connection.subscribe = connectionSubscribeBeforeInit;
        }

        initLogger({ subscriptionBreadcrumbs: false });
        assert.strictEqual(Meteor.connection.subscribe, connectionSubscribeBeforeInit);
        assert.strictEqual(Meteor.subscribe, subscribeBeforeInit);
    });
});
