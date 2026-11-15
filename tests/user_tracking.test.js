import { Meteor } from 'meteor/meteor';
import assert from 'assert';
import {
    fakeMeteorUser,
    initLogger,
    logged
} from './harness.js';

(Meteor.isClient ? describe : describe.skip)('tracking the Meteor user on the client', function() {
    let user;

    async function userOnNextEvent(message) {
        return (await logged('error', message)).event.user;
    }

    before(function() {
        user = fakeMeteorUser();
        initLogger();
    });

    after(function() {
        user.restore();
    });

    it('clears the Sentry user on logout', async function() {
        user.set({ emails: [{ address: 'alice@example.com' }] });
        assert.strictEqual((await userOnNextEvent('logged in as alice')).email, 'alice@example.com');

        user.set(null);
        assert.strictEqual((await userOnNextEvent('after logout'))?.email, undefined);
    });

    it('clears the Sentry user when the next user has no email', async function() {
        user.set({ emails: [{ address: 'alice@example.com' }] });
        assert.strictEqual((await userOnNextEvent('logged in as alice again')).email, 'alice@example.com');

        user.set({ emails: [] });
        assert.strictEqual((await userOnNextEvent('logged in as bob without email'))?.email, undefined);
    });

    it('clears the Sentry user when the next user has no emails field', async function() {
        user.set({ emails: [{ address: 'alice@example.com' }] });
        assert.strictEqual((await userOnNextEvent('logged in as alice once more')).email, 'alice@example.com');

        user.set({ services: { github: {} } });
        assert.strictEqual((await userOnNextEvent('logged in as an OAuth-only user'))?.email, undefined);
    });

    it('keeps tracking the user when trackUsers is passed as undefined', async function() {
        const options = initLogger({ trackUsers: undefined }).getOptions();

        assert.strictEqual(Object.prototype.hasOwnProperty.call(options, 'trackUsers'), false);

        user.set({ emails: [{ address: 'carol@example.com' }] });
        assert.strictEqual((await userOnNextEvent('logged in as carol')).email, 'carol@example.com');
    });
});
