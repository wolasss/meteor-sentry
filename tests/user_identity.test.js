import { Meteor } from 'meteor/meteor';
import assert from 'assert';
import {
    fakeMeteorUser,
    initLogger,
    logged
} from './harness.js';

(Meteor.isClient ? describe : describe.skip)('identifying the Meteor user on the client', function() {
    let user;

    async function userOnNextEvent() {
        return (await logged('error')).event.user;
    }

    before(function() {
        user = fakeMeteorUser();
        initLogger();
    });

    after(function() {
        user.set(null);
        user.restore();
        initLogger();
    });

    it('sets the id and the email of a user with an email', async function() {
        user.set({ _id: 'u1', emails: [{ address: 'a@example.com' }] });
        const sentryUser = await userOnNextEvent();

        assert.strictEqual(sentryUser.id, 'u1');
        assert.strictEqual(sentryUser.email, 'a@example.com');
    });

    it('identifies a user without an email by id', async function() {
        user.set({ _id: 'u2', services: {} });
        const sentryUser = await userOnNextEvent();

        assert.strictEqual(sentryUser.id, 'u2');
        assert.strictEqual(sentryUser.email, undefined);
    });

    it('drops the earlier email when the next user has none', async function() {
        user.set({ _id: 'u1', emails: [{ address: 'a@example.com' }] });
        assert.strictEqual((await userOnNextEvent()).email, 'a@example.com');

        user.set({ _id: 'u3', emails: [] });
        const sentryUser = await userOnNextEvent();

        assert.strictEqual(sentryUser.id, 'u3');
        assert.strictEqual(sentryUser.email, undefined);
    });

    it('clears the id and the email on logout', async function() {
        user.set({ _id: 'u1', emails: [{ address: 'a@example.com' }] });
        assert.strictEqual((await userOnNextEvent()).id, 'u1');

        user.set(null);
        const sentryUser = await userOnNextEvent();

        assert.strictEqual(sentryUser?.id, undefined);
        assert.strictEqual(sentryUser?.email, undefined);
    });

    // Last: it leaves tracking off until the after hook re-inits with the defaults.
    it('sets no user when trackUsers is off', async function() {
        initLogger({ trackUsers: false });
        user.set({ _id: 'u5', emails: [{ address: 'e@example.com' }] });
        const sentryUser = await userOnNextEvent();

        assert.strictEqual(sentryUser?.id, undefined);
        assert.strictEqual(sentryUser?.email, undefined);
    });
});
