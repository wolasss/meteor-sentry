import { Meteor } from 'meteor/meteor';
import { Tracker } from 'meteor/tracker';
import { createConnectionWrapper } from './connection_wrapper';
import { breadcrumb } from './breadcrumbs';
import { traceMethodCall } from './client_spans';
import { Sentry, loadSentry } from './client_sdk';

const methodCalls = createConnectionWrapper({
    names: ['apply', 'applyAsync'],
    behaviours: { breadcrumbs: breadcrumb('meteor.method'), trace: traceMethodCall }
});
const subscriptions = createConnectionWrapper({
    names: ['subscribe'],
    behaviours: { breadcrumbs: breadcrumb('meteor.subscription') }
});

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

            // Meteor.userId() is set while a resumed session waits for the user document.
            const userId = (typeof Meteor.userId === 'function' && Meteor.userId()) || (user && user._id);

            if(userId) {
                sentryUser.id = userId;
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
