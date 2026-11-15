import * as Sentry from '@sentry/node';
import { currentInvocation } from './server_context';

// Sentry keeps breadcrumbs on the isolation scope, and nothing forks one per DDP
// method or publication: every invocation that arrives over the same WebSocket,
// or none, shares it. A breadcrumb left there would ride on another user's event.
// So one left inside an invocation goes on a scope of that invocation's own, and
// only the events that invocation captures carry it. Outside an invocation it
// goes on the ambient isolation scope, which Sentry forks per HTTP request.
//
// The invocation object is the key: Meteor hands the same one to every await of
// a method or publication, and the WeakMap lets it go when the invocation does.
const invocationScopes = new WeakMap();

// Sentry's own addBreadcrumb, so beforeBreadcrumb and maxBreadcrumbs still apply.
export function addInvocationBreadcrumb(breadcrumb) {
    const invocation = currentInvocation();

    if(!invocation) {
        Sentry.addBreadcrumb(breadcrumb);
        return;
    }

    let scope = invocationScopes.get(invocation);

    if(!scope) {
        scope = new Sentry.Scope();
        invocationScopes.set(invocation, scope);
    }

    Sentry.withIsolationScope(scope, () => Sentry.addBreadcrumb(breadcrumb));
}

// Runs capture so the event carries the running invocation's breadcrumbs after
// the ambient ones. The ambient isolation scope is cloned, never written to.
export function withInvocationBreadcrumbs(capture) {
    const invocation = currentInvocation();
    const scope = invocation && invocationScopes.get(invocation);

    if(!scope) {
        return capture();
    }

    const isolationScope = Sentry.getIsolationScope().clone();
    const maxBreadcrumbs = Sentry.getClient()?.getOptions().maxBreadcrumbs;

    scope.getScopeData().breadcrumbs.forEach(breadcrumb => isolationScope.addBreadcrumb(breadcrumb, maxBreadcrumbs));

    return Sentry.withIsolationScope(isolationScope, capture);
}
