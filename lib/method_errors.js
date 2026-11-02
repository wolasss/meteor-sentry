import * as Sentry from '@sentry/node';
import { Meteor } from 'meteor/meteor';
import { currentInvocationContext } from './server_context';

// Meteor catches a method's exception at dispatch and sends it to the client,
// so it never reaches an uncaught-exception handler. Wrapping the handler is
// the only place to see it. Meteor.server.method_handlers is private API: a
// Meteor without it gets nothing installed.

const wrapped = Symbol('wolas:sentry wrapped');

function report(error) {
    // A Meteor.Error is the handler's intended answer to the client, not a crash.
    if(error instanceof Meteor.Error) {
        return;
    }

    // A hint holding tags or user is read as a scope context and loses the
    // mechanism, so the context goes under captureContext.
    Sentry.captureException(error, {
        captureContext: currentInvocationContext() || {},
        mechanism: { type: 'meteor.method', handled: false }
    });
}

// Rethrows the same value: Meteor reads isClientSafe, sanitizedError and
// instanceof Meteor.Error off it to decide what the client sees. A sync
// handler stays sync.
function wrap(handler) {
    if(handler[wrapped]) {
        return handler;
    }

    const wrapper = function(...args) {
        try {
            const result = handler.apply(this, args);

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
    };

    wrapper[wrapped] = true;

    return wrapper;
}

export function installMethodErrorCapture() {
    const server = Meteor.server;

    if(!server || !server.method_handlers || typeof server.methods !== 'function') {
        return;
    }

    Object.entries(server.method_handlers).forEach(([name, handler]) => {
        if(typeof handler === 'function') {
            server.method_handlers[name] = wrap(handler);
        }
    });

    if(server.methods[wrapped]) {
        return;
    }

    // Packages register on the server directly (validated-method, allow/deny),
    // so the server's own methods() is the one to wrap. It delegates to
    // Meteor's original so its duplicate-name and non-function errors stay.
    const registerMethods = server.methods;

    server.methods = function(methods) {
        return registerMethods.call(this, Object.fromEntries(Object.entries(methods).map(([name, handler]) =>
            [name, typeof handler === 'function' ? wrap(handler) : handler])));
    };
    server.methods[wrapped] = true;

    // Meteor.methods is a copy bound at load, which would keep calling the original.
    Meteor.methods = server.methods.bind(server);
}
