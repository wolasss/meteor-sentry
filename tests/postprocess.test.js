import assert from 'assert';
import Logger from 'meteor/wolas:sentry';
import {
    dsn,
    postprocessCalls,
    logged,
    setPostprocessFailure
} from './harness.js';

describe('postprocess hook isolation', function() {
    const originalConsoleError = console.error;
    let consoleErrorCalls;

    beforeEach(function() {
        consoleErrorCalls = [];
        console.error = (...args) => consoleErrorCalls.push(args);
    });

    afterEach(function() {
        console.error = originalConsoleError;
        setPostprocessFailure();
    });

    it('contains a throwing hook and still returns the event id', async function() {
        const postprocessError = new Error('hook failed');
        setPostprocessFailure({ error: postprocessError });
        const { eventId, event } = await logged('error', 'hook throws', { a: 1 });

        assert.strictEqual(typeof eventId, 'string');
        assert.strictEqual(event.message, 'hook throws');
        assert.strictEqual(postprocessCalls.length, 1);
        assert.strictEqual(consoleErrorCalls.length, 1);
        assert.ok(consoleErrorCalls[0].includes(postprocessError));
    });

    it('contains an async hook that rejects', async function() {
        const postprocessRejection = new Error('async hook failed');
        setPostprocessFailure({ rejection: postprocessRejection });
        const { eventId } = await logged('error', 'async hook rejects');
        await new Promise(resolve => setTimeout(resolve, 0));

        assert.strictEqual(typeof eventId, 'string');
        assert.strictEqual(consoleErrorCalls.length, 1);
        assert.ok(consoleErrorCalls[0].includes(postprocessRejection));
    });

    it('keeps calling the hook after it threw', function() {
        Logger.warning('after hook threw', { attempt: 2 });

        assert.deepStrictEqual(postprocessCalls, [
            { level: 'warning', event: 'after hook threw', extra: { attempt: 2 } }
        ]);
        assert.strictEqual(consoleErrorCalls.length, 0);
    });

    it('rejects a missing or non-object options argument', async function() {
        assert.throws(() => Logger.init(), { name: 'TypeError', message: /Logger\.init/ });
        [null, dsn].forEach(value => {
            assert.throws(() => Logger.init(value), { name: 'TypeError', message: /Logger\.init/ });
        });

        const { event } = await logged('error', 'after rejected init');

        assert.strictEqual(postprocessCalls[0].event, 'after rejected init');
        assert.strictEqual(event.message, 'after rejected init');
    });
});
