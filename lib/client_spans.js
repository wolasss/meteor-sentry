import * as Sentry from './vendor/sentry-browser.js';

// The span half of the client's apply/applyAsync wrapper (see breadcrumbs.js).
//
// The browser SDK has no async context, so startSpan cannot follow a call to
// its end, and around applyAsync it would return a new promise without the
// stubPromise and serverPromise Meteor puts on its own. The span is started
// inactive and ended by hand, in exactly one place per path:
// - applyAsync: when the promise Meteor returned settles. That same promise is
//   returned, untouched.
// - apply or applyAsync with a callback (Meteor.call lands here): when the
//   callback fires. applyAsync's promise then resolves on dispatch, so only its
//   rejection ends the span.
// - apply without one: when apply returns. Meteor's own default callback only
//   logs an error and the caller never sees the result, so this span measures
//   the dispatch only. Wrapping that callback would mean re-implementing it.
// - a synchronous throw (a stub with throwStubExceptions, a wrapper above
//   Meteor's): in a catch, before the same value is rethrown.
//
// Every error marks the span failed, a Meteor.Error included: on the client a
// server crash arrives as a Meteor.Error too, so it cannot be told apart from
// an intended denial.
//
// The tag is set inside withScope: the forked scope is the one captured on the
// span, so the tag reaches this transaction and no other event, and the user
// trackUsers put on the global scope is inherited. forceTransaction keeps the
// span a transaction of its own under browserTracingIntegration's pageload or
// navigation span. The method's arguments never reach Sentry.

// @sentry/browser does not export SPAN_STATUS_ERROR.
const SPAN_STATUS_ERROR = 2;

const isFunction = value => typeof value === 'function';

// Mirrors Meteor's _apply, which both apply and applyAsync reach:
// (args, options, callback), or (args, callback).
function callbackIndex(rest) {
    if(isFunction(rest[2])) {
        return 2;
    }

    if(isFunction(rest[1]) && !rest[2]) {
        return 1;
    }

    return -1;
}

export function traceMethodCall(fnName, name, rest, next) {
    const span = Sentry.withScope(scope => {
        scope.setTag('meteor.method', name);

        return Sentry.startInactiveSpan({ name, op: 'meteor.method', forceTransaction: true, attributes: { 'meteor.method': name } });
    });
    let ended = false;
    const end = failed => {
        if(ended) {
            return;
        }

        ended = true;

        if(failed) {
            span.setStatus({ code: SPAN_STATUS_ERROR, message: 'internal_error' });
        }

        span.end();
    };

    try {
        const index = callbackIndex(rest);
        let args = rest;

        if(index !== -1) {
            const callback = rest[index];
            args = rest.slice();

            args[index] = function(error, ...results) {
                end(Boolean(error));
                return callback.call(this, error, ...results);
            };
        }

        if(fnName === 'applyAsync') {
            const promise = next(args);

            // Both handlers, so the derived promise never rejects unhandled.
            // With a callback the promise resolves on dispatch and the result
            // goes to the callback, so only a rejection ends the span here.
            promise.then(() => {
                if(index === -1) {
                    end(false);
                }
            }, () => end(true));

            return promise;
        }

        const result = next(args);

        if(index === -1) {
            end(false);
        }

        return result;
    } catch(error) {
        end(true);
        throw error;
    }
}
