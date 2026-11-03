import { Meteor } from 'meteor/meteor';
import { Tracker } from 'meteor/tracker';
import assert from 'assert';
import {
    initLogger,
    logged
} from './harness.js';
import {
    pingMethods,
    connectionApplyBeforeInit,
    connectionApplyAsyncBeforeInit
} from './before_init.js';

(Meteor.isClient ? describe : describe.skip)('method breadcrumbs and client options', function() {
    const originalUser = Meteor.user;

    async function methodBreadcrumbsOnNextEvent() {
        const { event } = await logged('error');
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

        const { event } = await logged('error', 'after trackUsers was turned off');
        assert.strictEqual(event.user?.email, undefined);
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

        const { event } = await logged('error', 'with trackUsers off');
        assert.strictEqual(event.user?.email, undefined);
    });
});
