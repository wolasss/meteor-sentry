import { Meteor } from 'meteor/meteor';
import { Tracker } from 'meteor/tracker';
import assert from 'assert';
import Logger from 'meteor/wolas:sentry';
import {
    initLogger,
    logged,
    markBreadcrumbs,
    breadcrumbsAfter
} from './harness.js';
import {
    pingMethods,
    connectionApplyBeforeInit,
    connectionApplyAsyncBeforeInit
} from './before_init.js';

(Meteor.isClient ? describe : describe.skip)('method breadcrumbs and client options', function() {
    const originalUser = Meteor.user;

    async function methodBreadcrumbsSince(mark) {
        const { event } = await logged('error');
        return breadcrumbsAfter(event, mark, 'meteor.method');
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
        const mark = markBreadcrumbs();

        Meteor.call(callName, 'secret');
        await Meteor.callAsync(callAsyncName, 'secret');
        Meteor.apply(applyName, ['secret']);
        await Meteor.applyAsync(applyAsyncName, ['secret']);

        const breadcrumbs = await methodBreadcrumbsSince(mark);

        assert.deepStrictEqual(breadcrumbs.map(breadcrumb => breadcrumb.message), pingMethods);
        breadcrumbs.forEach(breadcrumb => {
            assert.strictEqual(breadcrumb.level, 'info');
            assert.strictEqual(breadcrumb.data, undefined);
        });
    });

    it('adds one breadcrumb per call after a second init', async function() {
        initLogger();
        const mark = markBreadcrumbs();
        Meteor.call(pingMethods[0]);

        const breadcrumbs = await methodBreadcrumbsSince(mark);
        assert.deepStrictEqual(breadcrumbs.map(breadcrumb => breadcrumb.message), [pingMethods[0]]);
    });

    it('counts exactly the new breadcrumbs when the buffer is already full', async function() {
        // Sentry applies its default of 100 when the option is unset, so the options do not carry it.
        const maxBreadcrumbs = initLogger().getOptions().maxBreadcrumbs ?? 100;

        // Fill it with the counted category, so a dropped old one would show as a missing new one.
        for(let index = 0; index < maxBreadcrumbs + 50; index++) {
            Logger.Sentry.addBreadcrumb({ category: 'meteor.method', message: 'filler' });
        }

        const mark = markBreadcrumbs();
        Meteor.call(pingMethods[0]);

        const { event } = await logged('error');
        assert.strictEqual(event.breadcrumbs.length, maxBreadcrumbs);

        const breadcrumbs = breadcrumbsAfter(event, mark, 'meteor.method');
        assert.deepStrictEqual(breadcrumbs.map(breadcrumb => breadcrumb.message), [pingMethods[0]]);
        assert.strictEqual(breadcrumbs[0].level, 'info');
        assert.strictEqual(breadcrumbs[0].data, undefined);
    });

    it('restores the connection when methodBreadcrumbs is false, and keeps the options out of Sentry', async function() {
        const options = initLogger({ methodBreadcrumbs: false, trackUsers: false }).getOptions();

        ['methodBreadcrumbs', 'trackUsers', 'postprocess', 'levels'].forEach(name => {
            assert.strictEqual(name in options, false, name);
        });
        assert.strictEqual(Meteor.connection.apply, connectionApplyBeforeInit);
        assert.strictEqual(Meteor.connection.applyAsync, connectionApplyAsyncBeforeInit);

        const mark = markBreadcrumbs();
        Meteor.call(pingMethods[0]);

        assert.deepStrictEqual(await methodBreadcrumbsSince(mark), []);
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
            const mark = markBreadcrumbs();
            Meteor.apply(pingMethods[2], []);

            assert.deepStrictEqual(appWrapped, [pingMethods[2]]);
            const breadcrumbs = await methodBreadcrumbsSince(mark);
            assert.deepStrictEqual(breadcrumbs.map(breadcrumb => breadcrumb.message), [pingMethods[2]]);

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
