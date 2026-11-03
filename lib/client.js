import * as Sentry from '@sentry/browser';
import { Meteor } from 'meteor/meteor';
import { Tracker } from 'meteor/tracker';
import { methodCalls, subscriptions } from './breadcrumbs';

let userTracker = null;

function init(sentryOptions, { trackUsers, methodBreadcrumbs, subscriptionBreadcrumbs, traceMethods }) {
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

    methodCalls.configure({ breadcrumbs: methodBreadcrumbs, trace: traceMethods });
    subscriptions.configure({ breadcrumbs: subscriptionBreadcrumbs });

    return ret;
}

export const platform = {
    Sentry,
    packageDefaults: {
        trackUsers: true,
        methodBreadcrumbs: true,
        subscriptionBreadcrumbs: true,
        traceMethods: false
    },
    init
};
