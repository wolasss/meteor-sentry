import * as Sentry from '@sentry/browser';
import { Meteor } from 'meteor/meteor';

// Meteor.apply and applyAsync are copies bound to the connection's own at
// load, so wrapping the connection alone would not reach them. Meteor.subscribe
// is the same kind of copy of the connection's subscribe. They are wrapped as
// they stand, which keeps any wrapper an app put there first. Meteor.call and
// callAsync need nothing: they go through the connection's apply and applyAsync.
//
// A breadcrumb carries the method's or subscription's name only. Its arguments
// can hold a password or a token: accounts-password logs in through Meteor.apply.
//
// Turning it off restores a function only where this module's wrapper is still
// the one in place. A wrapper other code put on top after init stays, and the
// wrapper underneath it stops adding breadcrumbs.

function withBreadcrumb(original, category, installed) {
    return function(name, ...rest) {
        if(installed.active) {
            Sentry.addBreadcrumb({ category, message: name, level: 'info' });
        }

        return original.call(this, name, ...rest);
    };
}

export function createBreadcrumbs({ category, names }) {
    let installed = null;

    function install() {
        const connection = Meteor.connection;

        if(installed || !connection || names.some(name => typeof connection[name] !== 'function' || typeof Meteor[name] !== 'function')) {
            return;
        }

        installed = { active: true, targets: [] };

        names.forEach(name => {
            [connection, Meteor].forEach(target => {
                const original = target[name];
                const wrapper = withBreadcrumb(original, category, installed);

                installed.targets.push({ target, name, original, wrapper });
                target[name] = wrapper;
            });
        });
    }

    function uninstall() {
        if(!installed) {
            return;
        }

        installed.active = false;
        installed.targets.forEach(({ target, name, original, wrapper }) => {
            if(target[name] === wrapper) {
                target[name] = original;
            }
        });
        installed = null;
    }

    return { install, uninstall };
}

export const methodBreadcrumbs = createBreadcrumbs({ category: 'meteor.method', names: ['apply', 'applyAsync'] });
export const subscriptionBreadcrumbs = createBreadcrumbs({ category: 'meteor.subscription', names: ['subscribe'] });
