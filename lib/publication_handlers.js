import { Meteor } from 'meteor/meteor';
import { traced } from './spans';

// Wraps every publication handler so a span can time its run, the way
// method_errors.js wraps method handlers. Meteor.server.publish_handlers,
// universal_publish_handlers and server.publish are private API: a Meteor
// without them gets nothing installed.
//
// Handlers registered through the wrapped publish() cannot be restored, so a
// later init turns tracing off through this switch, not by unwrapping.

const wrapped = Symbol('wolas:sentry wrapped publication');
let trace = false;

const universalName = 'meteor.publication (universal)';

// A universal publication has no name, so it carries no meteor.publication
// tag, as server_context.js does for events logged inside one. The span covers
// the handler run only, not the subscription's lifetime. Every thrown value
// marks it failed, a Meteor.Error included: a publication has no answer to a
// call that an error could be. Arguments never go on the span.
function wrap(name, handler) {
    if(handler[wrapped]) {
        return handler;
    }

    const tags = name ? { 'meteor.publication': name } : {};
    const attributes = name ? tags : { 'meteor.publication.universal': true };

    // The user comes from `this`, the subscription Meteor calls the handler with.
    const wrapper = function(...args) {
        if(!trace) {
            return handler.apply(this, args);
        }

        return traced({
            name: name || universalName,
            op: 'meteor.publication',
            tags,
            attributes,
            user: this && this.userId ? { id: this.userId } : undefined
        }, () => handler.apply(this, args));
    };

    wrapper[wrapped] = true;

    return wrapper;
}

function install() {
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

    if(server.publish[wrapped]) {
        return;
    }

    // It delegates to Meteor's original, so its own behaviour stays: a duplicate
    // name is ignored with a Meteor._debug line, and a universal publication
    // starts on every existing session.
    const registerPublish = server.publish;

    server.publish = function(name, handler, options) {
        if(name && typeof name === 'object') {
            return registerPublish.call(this, Object.fromEntries(Object.entries(name).map(([key, value]) =>
                [key, typeof value === 'function' ? wrap(key, value) : value])), handler, options);
        }

        return registerPublish.call(this, name, typeof handler === 'function' ? wrap(name || null, handler) : handler, options);
    };
    server.publish[wrapped] = true;

    // Meteor.publish is a copy bound at load, which would keep calling the original.
    Meteor.publish = server.publish.bind(server);
}

// Called on every init, so an init with it off turns off what an earlier one turned on.
export function configurePublicationHandlers({ trace: tracing }) {
    trace = Boolean(tracing);

    if(trace) {
        install();
    }
}
