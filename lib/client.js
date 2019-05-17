import * as Sentry from '@sentry/browser';
import { Meteor } from 'meteor/meteor';
import { Tracker } from 'meteor/tracker';

export function init(sentryOptions, {
    trackUsers = true
} = {}) {
    Sentry.init(sentryOptions);

    if(trackUsers) {
        Tracker.autorun(() => {
            const user = Meteor.user();

            if(user) {
                Sentry.configureScope(scope => {
                    scope.setUser(user);
                });
            }
        });
    }
}
