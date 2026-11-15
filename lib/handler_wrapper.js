import { Meteor } from 'meteor/meteor';

// One wrapper per server handler carries every per-handler behaviour of its
// kind (methods, publications), each behind its own switch, the way
// breadcrumbs.js does for the client's connection.
//
// Handlers registered through a wrapped register function cannot be restored,
// so a later init turns a behaviour off through its switch, never by
// unwrapping. Nothing is installed until a switch is first turned on, and with
// every switch off a wrapper only calls its handler through.
//
// A behaviour is (context, next) => result. The context holds the handler's
// name and `invocation`, the `this` Meteor calls it with; never its arguments.
// next() runs the rest of the chain and then the handler, with the same `this`
// and arguments. The behaviours' key order is the chain's: the first is
// outermost.
//
// install({ wrap, replaceRegister }) is the kind's own code: it knows where
// Meteor keeps that kind's handlers, and calls wrap(name, handler) on each.
export function createHandlerWrapper({ behaviours, install }) {
    // One per kind, so a function registered as two kinds is wrapped for each.
    const wrapped = Symbol('wolas:sentry wrapped');
    const names = Object.keys(behaviours);
    let switches = {};

    // Returns the handler's own result and rethrows what it threw, as long as
    // the behaviours do: Meteor reads isClientSafe, sanitizedError and
    // instanceof Meteor.Error off it. A sync handler stays sync.
    function wrap(name, handler) {
        if(handler[wrapped]) {
            return handler;
        }

        const wrapper = function(...args) {
            const active = names.filter(key => switches[key]);

            if(active.length === 0) {
                return handler.apply(this, args);
            }

            const context = { name, invocation: this };
            const callThrough = index => () => index < active.length
                ? behaviours[active[index]](context, callThrough(index + 1))
                : handler.apply(context.invocation, args);

            return callThrough(0)();
        };

        wrapper[wrapped] = true;

        return wrapper;
    }

    // Replaces Meteor.server[key], the register function packages call directly
    // (validated-method, allow/deny), once. makeReplacement gets Meteor's
    // original, to delegate to so its own errors and behaviour stay.
    function replaceRegister(key, makeReplacement) {
        const server = Meteor.server;

        if(server[key][wrapped]) {
            return;
        }

        server[key] = makeReplacement(server[key]);
        server[key][wrapped] = true;

        // Meteor[key] is a copy bound at load, which would keep calling the original.
        Meteor[key] = server[key].bind(server);
    }

    // Called on every init, so an init with every switch off turns off what an earlier one turned on.
    function configure(next) {
        switches = Object.fromEntries(names.map(key => [key, Boolean(next[key])]));

        if(names.some(key => switches[key])) {
            install({ wrap, replaceRegister });
        }
    }

    return { configure };
}
