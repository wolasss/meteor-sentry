import { Sentry } from './client_sdk';
import { Meteor } from 'meteor/meteor';
import { traceMethodCall } from './client_spans';

// Meteor.apply and applyAsync are copies bound to the connection's own at
// load, so wrapping the connection alone would not reach them. Meteor.subscribe
// is the same kind of copy of the connection's subscribe. They are wrapped as
// they stand, which keeps any wrapper an app put there first. Meteor.call and
// callAsync need nothing: they go through the connection's apply and applyAsync.
//
// One wrapper per function carries every per-call behaviour (the breadcrumb,
// the method span), each behind its own switch, so turning one on or off never
// installs a second wrapper or a second restore path. A behaviour is
// (fnName, name, rest, next) => result, and calls next(rest) to go on.
//
// A breadcrumb carries the method's or subscription's name only. Its arguments
// can hold a password or a token: accounts-password logs in through Meteor.apply.
//
// Turning every switch off restores a function only where this module's
// wrapper is still the one in place. A wrapper other code put on top after init
// stays, and the wrapper underneath it does nothing but call through.

function wrap(original, fnName, behaviours, installed) {
    return function(name, ...rest) {
        const active = Object.keys(behaviours).filter(key => installed.switches[key]);
        const callThrough = index => args => {
            if(index === active.length) {
                return original.call(this, name, ...args);
            }

            return behaviours[active[index]](fnName, name, args, callThrough(index + 1));
        };

        return callThrough(0)(rest);
    };
}

export function createConnectionWrapper({ names, behaviours }) {
    let installed = null;

    function install(switches) {
        const connection = Meteor.connection;

        if(installed) {
            installed.switches = switches;
            return;
        }

        if(!connection || names.some(name => typeof connection[name] !== 'function' || typeof Meteor[name] !== 'function')) {
            return;
        }

        installed = { switches, targets: [] };

        names.forEach(name => {
            [connection, Meteor].forEach(target => {
                const original = target[name];
                const wrapper = wrap(original, name, behaviours, installed);

                installed.targets.push({ target, name, original, wrapper });
                target[name] = wrapper;
            });
        });
    }

    function uninstall() {
        if(!installed) {
            return;
        }

        installed.switches = {};
        installed.targets.forEach(({ target, name, original, wrapper }) => {
            if(target[name] === wrapper) {
                target[name] = original;
            }
        });
        installed = null;
    }

    function configure(switches) {
        if(Object.keys(behaviours).some(key => switches[key])) {
            install({ ...switches });
        } else {
            uninstall();
        }
    }

    return { configure };
}

const breadcrumb = category => (fnName, name, rest, next) => {
    Sentry.addBreadcrumb({ category, message: name, level: 'info' });
    return next(rest);
};

export const methodCalls = createConnectionWrapper({
    names: ['apply', 'applyAsync'],
    behaviours: { breadcrumbs: breadcrumb('meteor.method'), trace: traceMethodCall }
});
export const subscriptions = createConnectionWrapper({
    names: ['subscribe'],
    behaviours: { breadcrumbs: breadcrumb('meteor.subscription') }
});
