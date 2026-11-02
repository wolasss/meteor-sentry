import * as Sentry from '@sentry/browser';
import { Meteor } from 'meteor/meteor';

// Meteor.apply and applyAsync are copies bound to the connection's own at
// load, so wrapping the connection alone would not reach them. They are
// wrapped as they stand, which keeps any wrapper an app put there first.
// Meteor.call and callAsync need nothing: they go through the connection's
// apply and applyAsync.
//
// A breadcrumb carries the method's name only. Its arguments can hold a
// password: accounts-password logs in through Meteor.apply.

const methods = ['apply', 'applyAsync'];

let originals = null;

function withBreadcrumb(original) {
    return function(name, ...rest) {
        Sentry.addBreadcrumb({ category: 'meteor.method', message: name, level: 'info' });

        return original.call(this, name, ...rest);
    };
}

export function installMethodBreadcrumbs() {
    const connection = Meteor.connection;

    if(originals || !connection || methods.some(name => typeof connection[name] !== 'function' || typeof Meteor[name] !== 'function')) {
        return;
    }

    originals = { connection: {}, aliases: {} };

    methods.forEach(name => {
        originals.connection[name] = connection[name];
        originals.aliases[name] = Meteor[name];
        connection[name] = withBreadcrumb(connection[name]);
        Meteor[name] = withBreadcrumb(Meteor[name]);
    });
}

export function uninstallMethodBreadcrumbs() {
    if(!originals) {
        return;
    }

    const connection = Meteor.connection;

    methods.forEach(name => {
        connection[name] = originals.connection[name];
        Meteor[name] = originals.aliases[name];
    });
    originals = null;
}
