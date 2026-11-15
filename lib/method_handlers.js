import * as Sentry from '@sentry/node';
import { Meteor } from 'meteor/meteor';
import { createHandlerWrapper } from './handler_wrapper';
import { currentInvocationContext } from './server_context';
import { traceHandler } from './spans';

// Meteor catches a method's exception at dispatch and sends it to the client,
// so it never reaches an uncaught-exception handler. Wrapping the handler is
// the only place to see it, and the one place a span can time it.
// Meteor.server.method_handlers is private API: a Meteor without it gets
// nothing installed.

// A Meteor.Error is the handler's intended answer to the client, not a crash.
// So is any error marked isClientSafe: Meteor sends it to the client as one,
// which lets packages answer without depending on Meteor.Error. Neither is
// reported, nor marks the method's span failed.
const isClientSafe = error => error instanceof Meteor.Error || Boolean(error && error.isClientSafe);

function report(error) {
    if(isClientSafe(error)) {
        return;
    }

    // A hint holding tags or user is read as a scope context and loses the
    // mechanism, so the context goes under captureContext.
    Sentry.captureException(error, {
        captureContext: currentInvocationContext() || {},
        mechanism: { type: 'meteor.method', handled: false }
    });
}

// Rethrows the same value, and a sync handler stays sync.
function captureErrors(context, next) {
    try {
        const result = next();

        return result && typeof result.then === 'function'
            ? result.then(undefined, error => {
                report(error);
                throw error;
            })
            : result;
    } catch(error) {
        report(error);
        throw error;
    }
}

function install({ wrap, replaceRegister }) {
    const server = Meteor.server;

    if(!server || !server.method_handlers || typeof server.methods !== 'function') {
        return;
    }

    Object.entries(server.method_handlers).forEach(([name, handler]) => {
        if(typeof handler === 'function') {
            server.method_handlers[name] = wrap(name, handler);
        }
    });

    // Packages register on the server directly (validated-method, allow/deny),
    // so the server's own methods() is the one to wrap. It delegates to
    // Meteor's original so its duplicate-name and non-function errors stay.
    replaceRegister('methods', registerMethods => function(methods) {
        return registerMethods.call(this, Object.fromEntries(Object.entries(methods).map(([name, handler]) =>
            [name, typeof handler === 'function' ? wrap(name, handler) : handler])));
    });
}

export const methodHandlers = createHandlerWrapper({
    // trace comes first, so the span is outermost and an error is reported inside it.
    behaviours: {
        trace: traceHandler(name => ({
            name,
            op: 'meteor.method',
            tags: { 'meteor.method': name },
            expected: isClientSafe
        })),
        captureErrors
    },
    install
});
