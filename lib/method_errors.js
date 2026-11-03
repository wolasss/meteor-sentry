import * as Sentry from '@sentry/node';
import { Meteor } from 'meteor/meteor';
import { currentInvocationContext } from './server_context';
import { traced } from './spans';

// Meteor catches a method's exception at dispatch and sends it to the client,
// so it never reaches an uncaught-exception handler. Wrapping the handler is
// the only place to see it, and the one place a span can time it, so this one
// wrapper holds both features. Meteor.server.method_handlers is private API: a
// Meteor without it gets nothing installed.
//
// Handlers registered through the wrapped methods() cannot be restored, so a
// later init turns a feature off through these switches, not by unwrapping.

const wrapped = Symbol('wolas:sentry wrapped');
let captureErrors = false;
let trace = false;

function report(error) {
    // A Meteor.Error is the handler's intended answer to the client, not a crash.
    // So is any error marked isClientSafe: Meteor sends it to the client as one,
    // which lets packages answer without depending on Meteor.Error.
    if(error instanceof Meteor.Error || (error && error.isClientSafe)) {
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
function wrap(name, handler) {
    if(handler[wrapped]) {
        return handler;
    }

    const reportIfCapturing = error => {
        if(captureErrors) {
            report(error);
        }
    };

    function run(...args) {
        try {
            const result = handler.apply(this, args);

            return result && typeof result.then === 'function'
                ? result.then(undefined, error => {
                    reportIfCapturing(error);
                    throw error;
                })
                : result;
        } catch(error) {
            reportIfCapturing(error);
            throw error;
        }
    }

    // The user comes from `this`, the invocation Meteor calls the handler with.
    // Arguments never go on the span: accounts-password logs in through a method.
    const wrapper = function(...args) {
        if(!trace) {
            return run.apply(this, args);
        }

        return traced({
            name,
            op: 'meteor.method',
            tags: { 'meteor.method': name },
            user: this && this.userId ? { id: this.userId } : undefined
        }, () => run.apply(this, args));
    };

    wrapper[wrapped] = true;

    return wrapper;
}

function install() {
    const server = Meteor.server;

    if(!server || !server.method_handlers || typeof server.methods !== 'function') {
        return;
    }

    Object.entries(server.method_handlers).forEach(([name, handler]) => {
        if(typeof handler === 'function') {
            server.method_handlers[name] = wrap(name, handler);
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
            [name, typeof handler === 'function' ? wrap(name, handler) : handler])));
    };
    server.methods[wrapped] = true;

    // Meteor.methods is a copy bound at load, which would keep calling the original.
    Meteor.methods = server.methods.bind(server);
}

// Called on every init, so an init with both off turns off what an earlier one turned on.
export function configureMethodHandlers({ captureErrors: capture, trace: tracing }) {
    captureErrors = Boolean(capture);
    trace = Boolean(tracing);

    if(captureErrors || trace) {
        install();
    }
}
