import { Meteor } from 'meteor/meteor';

// Registered before any init, so captureMethodErrors has to wrap them in place.
export const methodsBeforeInit = Meteor.methods;
export const serverMethodsBeforeInit = Meteor.isServer ? Meteor.server.methods : undefined;
export const syncErrorBeforeInit = new Error('sync before init');
export const asyncErrorBeforeInit = new Error('async before init');
export const connectionApplyBeforeInit = Meteor.isClient ? Meteor.connection.apply : undefined;
export const connectionApplyAsyncBeforeInit = Meteor.isClient ? Meteor.connection.applyAsync : undefined;
export const pingMethods = ['call', 'callAsync', 'apply', 'applyAsync'].map(alias => `wolas-sentry-test.ping.${alias}`);
export const syncHandlerBeforeInit = function() {
    throw syncErrorBeforeInit;
};

if(Meteor.isServer) {
    Meteor.methods({
        'wolas-sentry-test.before.sync': syncHandlerBeforeInit,
        async 'wolas-sentry-test.before.async'() {
            throw asyncErrorBeforeInit;
        },
        'wolas-sentry-test.before.denied'() {
            throw new Meteor.Error('denied');
        },
        ...Object.fromEntries(pingMethods.map(name => [name, () => {}]))
    });
}
