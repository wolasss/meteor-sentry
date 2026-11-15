// The client's Sentry SDK, fetched with a dynamic import when the app calls
// Logger.load(). Imported statically, it would sit in the app's initial bundle and
// delay the first page render.
//
// A live binding: undefined until the import resolves.
export let Sentry;

// One fetch for every caller. A failed fetch is not kept, so the next call tries again.
// onLoaded runs only on success, so a failed load leaves no partial state.
// Internal: the seam the tests use to inject a failing fetch.
export function createLoader(importSdk, onLoaded) {
    let loading;

    return function load() {
        if (!loading) {
            let fetching;

            try {
                fetching = importSdk();
            } catch (error) {
                fetching = Promise.reject(error);
            }

            loading = fetching.then(namespace => {
                onLoaded(namespace);
                return namespace;
            }, error => {
                loading = undefined;
                throw error;
            });
        }

        return loading;
    };
}

// The specifier must stay a string literal here, so Meteor's bundler splits the chunk.
const loadSdk = createLoader(() => import('./vendor/sentry-browser.js'), namespace => {
    Sentry = namespace;
});

export function loadSentry() {
    return loadSdk();
}
