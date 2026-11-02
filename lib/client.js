import * as Sentry from '@sentry/browser';
import { Meteor } from 'meteor/meteor';
import { Tracker } from 'meteor/tracker';
import { installMethodBreadcrumbs, uninstallMethodBreadcrumbs } from './method_breadcrumbs';

let userTracker = null;

export function init(sentryOptions, {
    trackUsers = true,
    methodBreadcrumbs = true
} = {}) {
    const ret = Sentry.init(sentryOptions);

    // An earlier init's tracker would keep setting the user after an opt-out.
    if(userTracker) {
        userTracker.stop();
        userTracker = null;
        Sentry.setUser(null);
    }

    // Meteor.user only exists when the app uses accounts-base.
    if(trackUsers && typeof Meteor.user === 'function') {
        userTracker = Tracker.autorun(() => {
            const user = Meteor.user();

            if(user && user.emails && user.emails[0] && user.emails[0].address) {
                Sentry.setUser({ email: user.emails[0].address });
            } else {
                Sentry.setUser(null);
            }
        });
    }

    if(methodBreadcrumbs) {
        installMethodBreadcrumbs();
    } else {
        uninstallMethodBreadcrumbs();
    }

    return ret;
}
