import { Meteor } from 'meteor/meteor';
import assert from 'assert';
import Logger from 'meteor/wolas:sentry';

const SeverityLevels = ['fatal', 'error', 'warning', 'log', 'info', 'debug', 'critical'];
const DefaultLevels = ['fatal', 'error', 'warning', 'critical'];
const environment = Meteor.isClient ? 'client' : 'server';
const dsn = 'https://public@sentry.invalid/1';

let pendingEvent;
const sentEvents = [];
const postprocessCalls = [];

function nextEvent() {
    return new Promise(resolve => {
        pendingEvent = resolve;
    });
}

function initLogger(options = {}) {
    Logger.init({
        dsn,
        beforeSend(event) {
            sentEvents.push(event);
            pendingEvent?.(event);
            pendingEvent = undefined;

            // Never send anything over the network.
            return null;
        },
        postprocess(level, event, extra) {
            postprocessCalls.push({ level, event, extra });
        },
        ...options
    });
}

async function assertSent(level) {
    const captured = nextEvent();
    const eventId = Logger[level](`${level} message`, { orderId: 42 });
    const event = await captured;

    assert.strictEqual(typeof eventId, 'string');
    assert.strictEqual(event.event_id, eventId);
    assert.strictEqual(event.message, `${level} message`);
    assert.strictEqual(event.level, level);
    assert.deepStrictEqual(event.extra, { orderId: 42 });
    assert.strictEqual(event.tags.key, environment);
}

// A message sent after the skipped one proves nothing was queued before it.
// Each sentinel is unique, or Sentry's dedupe integration drops repeats.
async function assertNotSent(level, event, sentinelLevel) {
    sentEvents.length = 0;
    postprocessCalls.length = 0;

    const sentinel = `sentinel after ${level}`;
    const eventId = Logger[level](event, { orderId: 42 });
    const captured = nextEvent();
    Logger[sentinelLevel](sentinel);
    await captured;

    assert.strictEqual(eventId, undefined);
    assert.deepStrictEqual(sentEvents.map(sentEvent => sentEvent.message), [sentinel]);
    assert.deepStrictEqual(postprocessCalls[0], { level, event, extra: { orderId: 42 } });
}

describe(`wolas:sentry on the ${environment}`, function() {
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

        it('sends an Error as an exception', async function() {
            const captured = nextEvent();
            const eventId = Logger.error(new Error('boom'));
            const event = await captured;

            assert.strictEqual(event.event_id, eventId);
            assert.strictEqual(event.exception.values[0].type, 'Error');
            assert.strictEqual(event.exception.values[0].value, 'boom');
        });

        it('calls postprocess with the level, event and extra data', function() {
            postprocessCalls.length = 0;
            Logger.warning('postprocessed', { attempt: 2 });

            assert.deepStrictEqual(postprocessCalls, [
                { level: 'warning', event: 'postprocessed', extra: { attempt: 2 } }
            ]);
        });
    });

    describe('with the default levels', function() {
        before(function() {
            initLogger();
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
    });

    describe('with custom levels', function() {
        before(function() {
            initLogger({ levels: ['info'] });
        });

        it('sends a listed level', async function() {
            await assertSent('info');
        });

        it('does not send an unlisted level, even for an Error', async function() {
            await assertNotSent('error', new Error('boom'), 'info');
        });
    });

    it('rejects unknown levels', function() {
        assert.throws(() => Logger.init({ dsn, levels: ['warn'] }), /unknown levels: warn/);
        assert.throws(() => Logger.init({ dsn, levels: 'error' }), /must be an array/);
    });
});
