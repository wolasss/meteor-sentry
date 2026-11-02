import { Meteor } from 'meteor/meteor';
import assert from 'assert';
import Logger from 'meteor/wolas:sentry';

const SeverityLevels = ['fatal', 'error', 'warning', 'log', 'info', 'debug', 'critical'];
const environment = Meteor.isClient ? 'client' : 'server';

let pendingEvent;
const postprocessCalls = [];

function nextEvent() {
    return new Promise(resolve => {
        pendingEvent = resolve;
    });
}

describe(`wolas:sentry on the ${environment}`, function() {
    before(function() {
        Logger.init({
            dsn: 'https://public@sentry.invalid/1',
            beforeSend(event) {
                pendingEvent?.(event);
                pendingEvent = undefined;

                // Never send anything over the network.
                return null;
            },
            postprocess(level, event, extra) {
                postprocessCalls.push({ level, event, extra });
            }
        });
    });

    it('exposes a method for every severity level', function() {
        SeverityLevels.forEach(level => {
            assert.strictEqual(typeof Logger[level], 'function', level);
        });
    });

    SeverityLevels.forEach(level => {
        it(`sends a ${level} message with its extra data and environment tag`, async function() {
            const captured = nextEvent();
            const eventId = Logger[level](`${level} message`, { orderId: 42 });
            const event = await captured;

            assert.strictEqual(typeof eventId, 'string');
            assert.strictEqual(event.event_id, eventId);
            assert.strictEqual(event.message, `${level} message`);
            assert.strictEqual(event.level, level);
            assert.deepStrictEqual(event.extra, { orderId: 42 });
            assert.strictEqual(event.tags.key, environment);
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
