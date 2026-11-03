import { Meteor } from 'meteor/meteor';
import { Tracker } from 'meteor/tracker';
import assert from 'assert';
import {
    initLogger,
    logged
} from './harness.js';

(Meteor.isClient ? describe : describe.skip)('tracking the Meteor user on the client', function() {
    const originalUser = Meteor.user;
    let dependency;
    let currentUser;

    function setCurrentUser(user) {
        currentUser = user;
        dependency.changed();
        Tracker.flush();
    }

    async function userOnNextEvent(message) {
        return (await logged('error', message)).event.user;
    }

    before(function() {
        dependency = new Tracker.Dependency();
        currentUser = null;
        // accounts-base is not in the test app, and init only tracks users when Meteor.user exists.
        Meteor.user = () => {
            dependency.depend();
            return currentUser;
        };
        initLogger();
    });

    after(function() {
        if(originalUser === undefined) {
            delete Meteor.user;
        } else {
            Meteor.user = originalUser;
        }
    });

    it('clears the Sentry user on logout', async function() {
        setCurrentUser({ emails: [{ address: 'alice@example.com' }] });
        assert.strictEqual((await userOnNextEvent('logged in as alice')).email, 'alice@example.com');

        setCurrentUser(null);
        assert.strictEqual((await userOnNextEvent('after logout'))?.email, undefined);
    });

    it('clears the Sentry user when the next user has no email', async function() {
        setCurrentUser({ emails: [{ address: 'alice@example.com' }] });
        assert.strictEqual((await userOnNextEvent('logged in as alice again')).email, 'alice@example.com');

        setCurrentUser({ emails: [] });
        assert.strictEqual((await userOnNextEvent('logged in as bob without email'))?.email, undefined);
    });

    it('clears the Sentry user when the next user has no emails field', async function() {
        setCurrentUser({ emails: [{ address: 'alice@example.com' }] });
        assert.strictEqual((await userOnNextEvent('logged in as alice once more')).email, 'alice@example.com');

        setCurrentUser({ services: { github: {} } });
        assert.strictEqual((await userOnNextEvent('logged in as an OAuth-only user'))?.email, undefined);
    });
});
