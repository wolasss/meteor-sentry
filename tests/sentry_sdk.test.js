import assert from 'assert';
import { Meteor } from 'meteor/meteor';
import Logger, { Sentry } from 'meteor/wolas:sentry';
import {
    environment,
    logged,
    sentryClient
} from './harness.js';

describe('the Sentry SDK as Logger.Sentry', function() {
    // Runs under the default levels' init.

    it('is the SDK the Logger sends through', async function() {
        // A scoped tag, because the shipped SDK keeps a tag cleared with undefined
        // as `tenant: undefined` on every later event, breaking their exact tags.
        let tagged;

        Logger.Sentry.withScope(scope => {
            scope.setTag('tenant', 'acme');
            // logged calls Logger.error before its first await, so inside this scope.
            tagged = logged('error');
        });

        const { event } = await tagged;

        assert.strictEqual(event.tags.tenant, 'acme');
        assert.strictEqual(event.tags.key, environment);

        // Later tests assert exact tags, so a leaked tag must fail here instead.
        const { event: untagged } = await logged('error');

        assert.strictEqual('tenant' in untagged.tags, false);
    });

    it('returns the client Logger.init configured', function() {
        assert.strictEqual(Logger.Sentry.getClient(), sentryClient());
    });

    it('is the named Sentry export', function() {
        assert.strictEqual(Sentry, Logger.Sentry);
        assert.strictEqual(typeof Logger.Sentry.captureException, 'function');
    });

    // Pins the 3.0 size cut: the bundled client SDK leaves these features out.
    (Meteor.isClient ? it : it.skip)('has no session replay, feedback widget or browser profiling on the client', function() {
        const leftOut = ['replayIntegration', 'replayCanvasIntegration', 'feedbackIntegration', 'sendFeedback', 'browserProfilingIntegration']
            .filter(name => name in Logger.Sentry);

        assert.deepStrictEqual(leftOut, []);
        assert.strictEqual(typeof Logger.Sentry.browserTracingIntegration, 'function');
    });

    it('cannot be replaced', function() {
        const before = Logger.Sentry;

        try {
            Logger.Sentry = {};
        } catch(error) {
            assert.strictEqual(error.name, 'TypeError');
        }

        assert.strictEqual(Logger.Sentry, before);
    });
});
