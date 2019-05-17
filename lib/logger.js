import * as SentryClient from '@sentry/browser';
import * as SentryServer from '@sentry/node';
import { Meteor } from 'meteor/meteor';
import { init as clientInit } from './client';
import { init as serverInit } from './server';

const init = Meteor.isClient ? clientInit : serverInit;

const Sentry = Meteor.isClient ? SentryClient : SentryServer;

const logger = {};

function log(level) {
    return function(event, tags) {
        if(event instanceof Error) {
            Sentry.captureException(event);
        } else {
            Sentry.captureEvent({
                message: event,
                level,
                tags: {
                    key: Meteor.isClient ? 'client' : 'server'
                }
            });
        }
    };
}

const SeverityLevels = ['fatal', 'error', 'warning', 'log', 'info', 'debug', 'critical'];

SeverityLevels.forEach(severity => {
    logger[severity] = log(severity);
});

logger.init = init;

export default logger;
