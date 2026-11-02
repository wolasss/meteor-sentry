import { DDP } from 'meteor/ddp';

// Meteor keeps the running method and publication in private per-invocation
// state. Reading it at capture time needs no Sentry scope carried across async
// boundaries. If a Meteor release drops that state, events go out untagged.

function read(environmentVariable) {
    return environmentVariable && typeof environmentVariable.get === 'function'
        ? environmentVariable.get()
        : undefined;
}

function build(tags, userId) {
    const definedTags = Object.fromEntries(Object.entries(tags).filter(([, value]) => value !== undefined));
    const context = { tags: definedTags };

    if(userId) {
        context.user = { id: userId };
    }

    return context;
}

/**
@returns {{ tags: object, user?: { id: string } } | null} - the running method or publication and its user, or null outside both.
*/
export function currentInvocationContext() {
    // A method called from inside a publication is the closer context.
    const method = read(DDP._CurrentMethodInvocation);

    if(method) {
        return build({ 'meteor.method': method.name }, method.userId);
    }

    const publication = read(DDP._CurrentPublicationInvocation);

    if(publication) {
        return build({ 'meteor.publication': publication._name }, publication.userId);
    }

    return null;
}
