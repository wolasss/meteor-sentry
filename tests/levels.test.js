import { Meteor } from 'meteor/meteor';
import assert from 'assert';
import Logger from 'meteor/wolas:sentry';
import {
    SeverityLevels,
    DefaultLevels,
    SentryLevelAliases,
    environment,
    postprocessCalls,
    initLogger,
    logged,
    eventsDuring
} from './harness.js';
import {
    methodsBeforeInit,
    serverMethodsBeforeInit,
    syncHandlerBeforeInit
} from './before_init.js';

async function assertSent(level) {
    const { eventId, event } = await logged(level, `${level} message`, { orderId: 42 });

    assert.strictEqual(typeof eventId, 'string');
    assert.strictEqual(event.event_id, eventId);
    assert.strictEqual(event.message, `${level} message`);
    assert.strictEqual(event.level, SentryLevelAliases[level] || level);
    assert.deepStrictEqual(event.extra, { orderId: 42 });
    assert.strictEqual(event.tags.key, environment);
}

async function assertNotSent(level, event, sentinelLevel) {
    let eventId;
    const events = await eventsDuring(() => {
        eventId = Logger[level](event, { orderId: 42 });
    }, sentinelLevel);

    assert.strictEqual(eventId, undefined);
    assert.deepStrictEqual(events, []);
    assert.deepStrictEqual(postprocessCalls[0], { level, event, extra: { orderId: 42 } });
}

describe('with every level enabled', function() {
    before(function() {
        initLogger({ levels: SeverityLevels });
    });

    it('exposes a method for every severity level', function() {
        SeverityLevels.forEach(level => {
            assert.strictEqual(typeof Logger[level], 'function', level);
        });
    });

    SeverityLevels.forEach(level => {
        it(`sends a ${level} message with its extra data and environment tag`, async function() {
            await assertSent(level);
        });
    });

    it('sends an Error as an exception with its level, extra data and environment tag', async function() {
        const { eventId, event } = await logged('warning', new Error('boom'), { orderId: 42 });

        assert.strictEqual(event.event_id, eventId);
        assert.strictEqual(event.exception.values[0].type, 'Error');
        assert.strictEqual(event.exception.values[0].value, 'boom');
        assert.strictEqual(event.level, 'warning');
        assert.deepStrictEqual(event.extra, { orderId: 42 });
        assert.strictEqual(event.tags.key, environment);
    });

    it('sends critical as fatal but postprocesses it as critical', async function() {
        const { event } = await logged('critical', 'critical as fatal');

        assert.strictEqual(event.level, 'fatal');
        assert.strictEqual(postprocessCalls[0].level, 'critical');
    });

    (Meteor.isServer ? it : it.skip)('leaves methods alone when captureMethodErrors and traceMethods are omitted', function() {
        assert.strictEqual(Meteor.methods, methodsBeforeInit);
        assert.strictEqual(Meteor.server.methods, serverMethodsBeforeInit);
        assert.strictEqual(Meteor.server.method_handlers['wolas-sentry-test.before.sync'], syncHandlerBeforeInit);
    });

    it('calls postprocess with the level, event and extra data', function() {
        Logger.warning('postprocessed', { attempt: 2 });

        assert.deepStrictEqual(postprocessCalls, [
            { level: 'warning', event: 'postprocessed', extra: { attempt: 2 } }
        ]);
    });
});

describe('with the default levels', function() {
    let initResult;

    before(function() {
        initResult = initLogger(Meteor.isServer ? { captureMethodErrors: true, traceMethods: true } : {});
    });

    it('returns the Sentry client without the package options in it', function() {
        assert.strictEqual(typeof initResult.getOptions, 'function');

        const options = initResult.getOptions();

        ['captureMethodErrors', 'traceMethods', 'postprocess', 'levels'].forEach(name => {
            assert.strictEqual(name in options, false, name);
        });
    });

    DefaultLevels.forEach(level => {
        it(`sends a ${level} message`, async function() {
            await assertSent(level);
        });
    });

    SeverityLevels.filter(level => !DefaultLevels.includes(level)).forEach(level => {
        it(`does not send a ${level} message but still postprocesses it`, async function() {
            await assertNotSent(level, `${level} message`, 'error');
        });
    });

    // Nested here so they run under this init, as before the split.
    require('./sentry_sdk.test.js');
    require('./postprocess.test.js');
    require('./server_context.test.js');
    require('./method_errors.test.js');
    require('./method_spans.test.js');
});

describe('with custom levels', function() {
    before(function() {
        // On the server it also turns traceMethods off after the default levels' init turned it on.
        initLogger(Meteor.isServer ? { levels: ['info'], captureMethodErrors: true } : { levels: ['info'] });
    });

    it('sends a listed level', async function() {
        await assertSent('info');
    });

    it('does not send an unlisted level, even for an Error', async function() {
        await assertNotSent('error', new Error('boom'), 'info');
    });

    require('./method_tracing_off.test.js');
});

(Meteor.isServer ? describe : describe.skip)('with method capture off and tracing on', function() {
    before(function() {
        initLogger({
            captureMethodErrors: false,
            traceMethods: true,
            // Client reports and these integrations add process listeners on every init; one more
            // full init on the server trips Node's listener limit (see server_context.test.js).
            sendClientReports: false,
            integrations: defaults => defaults.filter(integration =>
                !['OnUncaughtException', 'OnUnhandledRejection', 'ProcessSession'].includes(integration.name))
        });
    });

    require('./method_capture_off.test.js');
});
