import { Meteor } from 'meteor/meteor';
import { Tracker } from 'meteor/tracker';
import { methodCalls, subscriptions } from './breadcrumbs';
import { Sentry, loadSentry } from './client_sdk';

let userTracker = null;

function init(sentryOptions, { trackUsers, methodBreadcrumbs, subscriptionBreadcrumbs, traceMethods }) {
    if(!Sentry) {
        throw new Error('wolas:sentry: the client SDK is not loaded yet. Await Logger.load() before Logger.init.');
    }

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
            // Only the id and the first email leave the user document. The id matches the server's user.id.
            const sentryUser = {};

            if(user && user._id) {
                sentryUser.id = user._id;
            }
            if(user && user.emails && user.emails[0] && user.emails[0].address) {
                sentryUser.email = user.emails[0].address;
            }

            Sentry.setUser(Object.keys(sentryUser).length ? sentryUser : null);
        });
    }

    methodCalls.configure({ breadcrumbs: methodBreadcrumbs, trace: traceMethods });
    subscriptions.configure({ breadcrumbs: subscriptionBreadcrumbs });

    return ret;
}

export const platform = {
    sentry: () => Sentry,
    load: loadSentry,
    packageDefaults: {
        trackUsers: true,
        methodBreadcrumbs: true,
        subscriptionBreadcrumbs: true,
        traceMethods: false
    },
    init
};
