import { Meteor } from 'meteor/meteor';
import { createHandlerWrapper } from './handler_wrapper';
import { traceHandler } from './spans';

// Wraps every publication handler so a span can time its run, through the
// same wrapper as method handlers (handler_wrapper.js).
// Meteor.server.publish_handlers, universal_publish_handlers and
// server.publish are private API: a Meteor without them gets nothing installed.

const universalName = 'meteor.publication (universal)';

// A universal publication has no name, so it carries no meteor.publication
// tag, as server_context.js does for events logged inside one. Scope tags
// merge, so the tag is unset on the span's fork rather than left out, or one
// on the scope it forked from would carry over. The span covers
// the handler run only, not the subscription's lifetime. Every thrown value
// marks it failed, a Meteor.Error included: a publication has no answer to a
// call that an error could be.
function describeSpan(name) {
    const tags = { 'meteor.publication': name || undefined };

    return {
        name: name || universalName,
        op: 'meteor.publication',
        tags,
        attributes: name ? tags : { 'meteor.publication.universal': true }
    };
}

function install({ wrap, replaceRegister }) {
    const server = Meteor.server;

    if(!server || !server.publish_handlers || !Array.isArray(server.universal_publish_handlers)
        || typeof server.publish !== 'function') {
        return;
    }

    Object.entries(server.publish_handlers).forEach(([name, handler]) => {
        if(typeof handler === 'function') {
            server.publish_handlers[name] = wrap(name, handler);
        }
    });
    server.universal_publish_handlers.forEach((handler, index) => {
        if(typeof handler === 'function') {
            server.universal_publish_handlers[index] = wrap(null, handler);
        }
    });

    // A running subscription keeps the handler it started with, and a login or
    // logout reruns that one (Subscription._recreate), not the registry's.
    // Universal ones are restarted from universal_publish_handlers instead.
    if(server.sessions instanceof Map) {
        server.sessions.forEach(session => {
            if(session && session._namedSubs instanceof Map) {
                session._namedSubs.forEach(sub => {
                    if(sub && sub._name && typeof sub._handler === 'function') {
                        sub._handler = wrap(sub._name, sub._handler);
                    }
                });
            }
        });
    }

    // It delegates to Meteor's original, so its own behaviour stays: a duplicate
    // name is ignored with a Meteor._debug line, and a universal publication
    // starts on every existing session.
    replaceRegister('publish', registerPublish => function(name, handler, options) {
        if(name && typeof name === 'object') {
            return registerPublish.call(this, Object.fromEntries(Object.entries(name).map(([key, value]) =>
                [key, typeof value === 'function' ? wrap(key, value) : value])), handler, options);
        }

        return registerPublish.call(this, name, typeof handler === 'function' ? wrap(name || null, handler) : handler, options);
    });
}

export const publicationHandlers = createHandlerWrapper({
    behaviours: { trace: traceHandler(describeSpan) },
    install
});
