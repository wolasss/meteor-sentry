import * as Sentry from '@sentry/node';

// Runs `run` inside a Sentry span that is always its own transaction, and
// returns exactly what `run` returned: a sync value stays sync, a thrown value
// is rethrown as is after the span gets an error status.
//
// forceTransaction: Sentry's HTTP instrumentation can leave a span active for
// the WebSocket a DDP session rides on. Without it the span would be that
// span's child, and never sent as a transaction of its own.
//
// Tags and user go on the scope startSpan forked for the callback, because the
// fork is what is captured on the span. Sentry.setUser or setTag would write to
// the isolation scope one request shares with every later event. The user is
// always set, to null when there is none, so an anonymous call cannot inherit
// one from the scope it was forked from.
//
// An error `expected` accepts is the handler's intended answer, such as a
// denial, not a failure. startSpan marks every value that escapes its callback
// as internal_error, so such an error leaves the callback held in a box and is
// rethrown, the same value, once the span has ended with its status untouched.
class Expected {
    constructor(error) {
        this.error = error;
    }
}

const isThenable = value => value && typeof value.then === 'function';

export function traced({ name, op, tags = {}, user, expected = () => false }, run) {
    const hold = error => {
        if(expected(error)) {
            return new Expected(error);
        }

        throw error;
    };
    const release = value => {
        if(value instanceof Expected) {
            throw value.error;
        }

        return value;
    };

    const result = Sentry.startSpan({ name, op, forceTransaction: true, attributes: tags }, () => {
        const scope = Sentry.getCurrentScope();

        scope.setTags(tags);
        scope.setUser(user || null);

        try {
            const value = run();

            return isThenable(value) ? value.then(undefined, hold) : value;
        } catch(error) {
            return hold(error);
        }
    });

    return isThenable(result) ? result.then(release) : release(result);
}
