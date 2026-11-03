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

function withBreadcrumb(original, category) {
    return function(name, ...rest) {
        Sentry.addBreadcrumb({ category, message: name, level: 'info' });

        return original.call(this, name, ...rest);
    };
}

export function createBreadcrumbs({ category, names }) {
    let originals = null;

    function install() {
        const connection = Meteor.connection;

        if(originals || !connection || names.some(name => typeof connection[name] !== 'function' || typeof Meteor[name] !== 'function')) {
            return;
        }

        originals = { connection: {}, aliases: {} };

        names.forEach(name => {
            originals.connection[name] = connection[name];
            originals.aliases[name] = Meteor[name];
            connection[name] = withBreadcrumb(connection[name], category);
            Meteor[name] = withBreadcrumb(Meteor[name], category);
        });
    }

    function uninstall() {
        if(!originals) {
            return;
        }

        const connection = Meteor.connection;

        names.forEach(name => {
            connection[name] = originals.connection[name];
            Meteor[name] = originals.aliases[name];
        });
        originals = null;
    }

    return { install, uninstall };
}

export const methodBreadcrumbs = createBreadcrumbs({ category: 'meteor.method', names: ['apply', 'applyAsync'] });
export const subscriptionBreadcrumbs = createBreadcrumbs({ category: 'meteor.subscription', names: ['subscribe'] });
