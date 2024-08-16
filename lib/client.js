import * as Sentry from '@sentry/browser';
import { Meteor } from 'meteor/meteor';
import { Tracker } from 'meteor/tracker';

export function init(sentryOptions, {
    trackUsers = true
} = {}) {
    const ret = Sentry.init(sentryOptions);

    if(trackUsers) {
        Tracker.autorun(() => {
            const user = Meteor.user();

            if(user && user.emails && user.emails[0] && user.emails[0].address) {
                Sentry.setUser({ email: user.emails[0].address });
            }
        });
    }

    return ret;
}
