import { Meteor } from 'meteor/meteor';
import Logger from 'meteor/wolas:sentry';

export const SeverityLevels = ['fatal', 'error', 'warning', 'log', 'info', 'debug', 'critical'];
export const DefaultLevels = ['fatal', 'error', 'warning', 'critical'];
export const SentryLevelAliases = { critical: 'fatal' };
export const environment = Meteor.isClient ? 'client' : 'server';
export const dsn = 'https://public@sentry.invalid/1';

let pendingEvent;
let pendingTransaction;
let client;
const sentEvents = [];
const sentTransactions = [];
export const postprocessCalls = [];
let postprocessError;
let postprocessRejection;

// Each Sentry.init builds a fresh dedupe integration, so a message only has to be unique
// between two initLogger calls. A test that calls Logger.init directly and succeeds would
// not clear this; none does, every direct call is expected to throw.
const messagesSinceInit = new Set();
let sequence = 0;

function mint(prefix) {
    sequence += 1;
    return `${prefix} message #${sequence}`;
}

// For an event not produced by a Logger call, such as a method's crash.
export function nextEvent() {
    return new Promise(resolve => {
        pendingEvent = resolve;
    });
}

// For a transaction, such as a traced method's. Resolves with the first one the predicate accepts.
export function nextTransaction(predicate = () => true) {
    return new Promise(resolve => {
        pendingTransaction = { predicate, resolve };
    });
}

export function initLogger(options = {}) {
    messagesSinceInit.clear();

    client = Logger.init({
        dsn,
        // Samples every span, so a missing transaction proves the switch, not the sampler.
        tracesSampleRate: 1,
        // Sentry 11 streams spans by default, which skips beforeSendTransaction and sends them
        // over the network. Static keeps one transaction event per root span, recorded here.
        traceLifecycle: 'static',
        beforeSendTransaction(event) {
            sentTransactions.push(event);

            if(pendingTransaction && pendingTransaction.predicate(event)) {
                pendingTransaction.resolve(event);
                pendingTransaction = undefined;
            }

            return null;
        },
        beforeSend(event) {
            sentEvents.push(event);
            pendingEvent?.(event);
            pendingEvent = undefined;

            // Never send anything over the network.
            return null;
        },
        postprocess(level, event, extra) {
            postprocessCalls.push({ level, event, extra });

            if(postprocessError) {
                throw postprocessError;
            }

            if(postprocessRejection) {
                return Promise.reject(postprocessRejection);
            }
        },
        ...options
    });

    return client;
}

// The Sentry client the latest initLogger configured.
export function sentryClient() {
    return client;
}

// Logs through Logger[level] and waits for the event Sentry captured for it.
// Without an event it logs a message no other test uses.
export async function logged(level, event = mint(level), extra) {
    if(typeof event === 'string') {
        if(messagesSinceInit.has(event)) {
            throw new Error(`"${event}" was already logged under this init; Sentry's dedupe integration would drop it`);
        }

        messagesSinceInit.add(event);
    }

    const captured = nextEvent();
    const eventId = Logger[level](event, extra);

    if(eventId === undefined) {
        throw new Error(`Logger.${level} sent nothing: the level is not enabled under this init`);
    }

    const capturedEvent = await captured;

    if(capturedEvent.event_id !== eventId) {
        throw new Error(`Logger.${level} returned ${eventId} but Sentry captured ${capturedEvent.event_id}`);
    }

    return { eventId, event: capturedEvent };
}

// Sentry keeps only the last maxBreadcrumbs across inits, so counting a category before and
// after an action comes out short once that buffer is full. Count from a mark instead.
export function markBreadcrumbs() {
    const message = mint('breadcrumb mark');
    Logger.Sentry.addBreadcrumb({ category: 'test.mark', message });
    return message;
}

// The breadcrumbs of category the event carries after the mark.
export function breadcrumbsAfter(event, mark, category) {
    const breadcrumbs = event.breadcrumbs || [];
    const index = breadcrumbs.findIndex(breadcrumb => breadcrumb.category === 'test.mark' && breadcrumb.message === mark);

    if(index === -1) {
        throw new Error(`the breadcrumb mark "${mark}" is not in the event: it was dropped or never added`);
    }

    return breadcrumbs.slice(index + 1).filter(breadcrumb => breadcrumb.category === category);
}

// The events Sentry captured while action ran. A sentinel logged after it proves nothing
// else was still queued.
export async function eventsDuring(action, sentinelLevel = 'error') {
    const start = sentEvents.length;
    await action();

    // An exception event is still being processed (its source context is read async)
    // when a message logged after it is done, so flush before the sentinel.
    if(!await client.flush(2000)) {
        throw new Error('Sentry was still processing an event after 2s');
    }

    const { event: sentinel } = await logged(sentinelLevel, mint('sentinel'));

    if(sentEvents[sentEvents.length - 1] !== sentinel) {
        throw new Error('the sentinel was not the last event Sentry captured');
    }

    return sentEvents.slice(start, -1);
}

// The transactions Sentry finished while action ran. A sentinel transaction ended after it
// proves nothing else was still queued.
export async function transactionsDuring(action) {
    const start = sentTransactions.length;
    await action();

    if(!await client.flush(2000)) {
        throw new Error('Sentry was still processing an event after 2s');
    }

    const name = mint('sentinel transaction');
    const sentinel = nextTransaction(event => event.transaction === name);
    Logger.Sentry.startSpan({ name, forceTransaction: true }, () => {});
    await sentinel;

    const end = sentTransactions.findIndex((event, index) => index >= start && event.transaction === name);

    return sentTransactions.slice(start, end);
}

// Sentry's HTTP instrumentation can add transactions of its own beside a method's.
export function methodTransactions(transactions) {
    return transactions.filter(event => event.contexts?.trace?.op === 'meteor.method');
}

// Called with no argument it clears both failures.
export function setPostprocessFailure({ error, rejection } = {}) {
    postprocessError = error;
    postprocessRejection = rejection;
}

export function reset() {
    sentEvents.length = 0;
    sentTransactions.length = 0;
    postprocessCalls.length = 0;
}
