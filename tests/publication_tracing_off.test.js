import { Meteor } from 'meteor/meteor';
import { DDP } from 'meteor/ddp';
import assert from 'assert';
import {
    transactionsDuring,
    publicationTransactions
} from './harness.js';

(Meteor.isServer ? describe : describe.skip)('tracePublications turned off by a later init', function() {
    // Runs under the custom levels' init: tracePublications omitted after an init that had it on.
    const result = { marker: 'off' };

    before(function() {
        Meteor.publish('wolas-sentry-test.pub-off.sync', function() {
            return result;
        });
    });

    it('sends no transaction and still returns the handler\'s value', async function() {
        const sub = { _name: 'wolas-sentry-test.pub-off.sync', userId: 'user-1', ready() {} };
        let returned;
        const transactions = await transactionsDuring(() => {
            returned = DDP._CurrentPublicationInvocation.withValue(sub, () =>
                Meteor.server.publish_handlers['wolas-sentry-test.pub-off.sync'].call(sub));
        });

        assert.deepStrictEqual(publicationTransactions(transactions), []);
        assert.strictEqual(returned, result);
    });
});
