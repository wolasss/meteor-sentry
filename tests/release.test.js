import assert from 'assert';
import { Meteor } from 'meteor/meteor';
import { environment, initLogger, logged, sentryClient } from './harness.js';

const stubHash = 'abc123stub';

// Every server client adds a process listener, and one more init trips Node's listener limit
// (see levels.test.js). Closing the client each init replaces takes its listeners off again.
// Client reports and these integrations add listeners that close does not take off; ChildProcess
// subscribes once per init and would trip the limit on the test browser's own child process.
async function initWithRelease(options = {}) {
    await sentryClient()?.close();

    return initLogger({
        sendClientReports: false,
        integrations: defaults => defaults.filter(integration =>
            !['OnUncaughtException', 'OnUnhandledRejection', 'ProcessSession', 'ChildProcess'].includes(integration.name)),
        ...options
    });
}

async function loggedRelease() {
    return (await logged('error')).event.release;
}

describe(`the default release on the ${environment}`, function() {
    const originalHash = Meteor.gitCommitHash;
    const hadHash = Object.prototype.hasOwnProperty.call(Meteor, 'gitCommitHash');
    const originalEnvRelease = Meteor.isServer ? process.env.SENTRY_RELEASE : undefined;
    const originalGlobalRelease = globalThis.SENTRY_RELEASE;

    beforeEach(function() {
        Meteor.gitCommitHash = stubHash;

        if(Meteor.isServer) {
            delete process.env.SENTRY_RELEASE;
        }

        delete globalThis.SENTRY_RELEASE;
    });

    afterEach(function() {
        if(hadHash) {
            Meteor.gitCommitHash = originalHash;
        } else {
            delete Meteor.gitCommitHash;
        }

        if(Meteor.isServer) {
            // Assigning undefined would set the string 'undefined'.
            if(originalEnvRelease === undefined) {
                delete process.env.SENTRY_RELEASE;
            } else {
                process.env.SENTRY_RELEASE = originalEnvRelease;
            }
        }

        if(originalGlobalRelease === undefined) {
            delete globalThis.SENTRY_RELEASE;
        } else {
            globalThis.SENTRY_RELEASE = originalGlobalRelease;
        }
    });

    it('uses the commit Meteor was built from when the app sets no release', async function() {
        await initWithRelease();
        assert.strictEqual(await loggedRelease(), stubHash);
    });

    it('treats an explicit undefined release as unset', async function() {
        await initWithRelease({ release: undefined });
        assert.strictEqual(await loggedRelease(), stubHash);
    });

    it('keeps a release the app passed', async function() {
        await initWithRelease({ release: 'v1' });
        assert.strictEqual(await loggedRelease(), 'v1');
    });

    it('does not replace an empty release the app passed', async function() {
        await initWithRelease({ release: '' });
        assert.notStrictEqual(await loggedRelease(), stubHash);
    });

    it('adds no release without a commit hash', async function() {
        Meteor.gitCommitHash = undefined;
        await initWithRelease();

        const release = await loggedRelease();

        // The server SDK may still find a CI commit variable on the box by itself.
        assert.notStrictEqual(release, stubHash);

        if(Meteor.isClient) {
            assert.strictEqual(release, undefined);
        }
    });

    it('leaves a bundler-injected release to the SDK', async function() {
        globalThis.SENTRY_RELEASE = { id: 'bundled' };
        await initWithRelease();
        assert.strictEqual(await loggedRelease(), 'bundled');
    });

    (Meteor.isServer ? it : it.skip)('leaves the SENTRY_RELEASE environment variable to the SDK', async function() {
        process.env.SENTRY_RELEASE = 'env-release';
        await initWithRelease();
        assert.strictEqual(await loggedRelease(), 'env-release');
    });
});
