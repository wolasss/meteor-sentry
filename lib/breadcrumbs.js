import { Sentry } from './client_sdk';

// A breadcrumb carries the method's or subscription's name only. Its arguments
// can hold a password or a token: accounts-password logs in through Meteor.apply.
export const breadcrumb = category => (fnName, name, rest, next) => {
    Sentry.addBreadcrumb({ category, message: name, level: 'info' });
    return next(rest);
};
