import * as Sentry from '@sentry/browser';
import { Meteor } from 'meteor/meteor';

// Meteor.call, callAsync, apply and applyAsync are copies bound to the
// connection at load, so wrapping the connection alone would not reach them:
// each install and uninstall binds them again.
//
// A breadcrumb carries the method's name only. Its arguments can hold a
// password: accounts-password logs in through Meteor.apply.

const aliases = ['call', 'callAsync', 'apply', 'applyAsync'];

let originals = null;

function rebindAliases(connection) {
    aliases.forEach(name => {
        Meteor[name] = connection[name].bind(connection);
    });
}

function withBreadcrumb(original) {
    return function(name, ...rest) {
        Sentry.addBreadcrumb({ category: 'meteor.method', message: name, level: 'info' });

        return original.call(this, name, ...rest);
    };
}

export function installMethodBreadcrumbs() {
    const connection = Meteor.connection;

    if(originals || !connection || typeof connection.apply !== 'function' || typeof connection.applyAsync !== 'function') {
        return;
    }

    originals = { apply: connection.apply, applyAsync: connection.applyAsync };

    connection.apply = withBreadcrumb(originals.apply);
    connection.applyAsync = withBreadcrumb(originals.applyAsync);

    rebindAliases(connection);
}

export function uninstallMethodBreadcrumbs() {
    if(!originals) {
        return;
    }

    const connection = Meteor.connection;

    connection.apply = originals.apply;
    connection.applyAsync = originals.applyAsync;
    originals = null;

    rebindAliases(connection);
}
