// The client's Sentry SDK, fetched with a dynamic import when the app calls
// Logger.load(). Imported statically, it would sit in the app's initial bundle and
// delay the first page render.
//
// A live binding: undefined until the import resolves.
export let Sentry;

let loading;

export function loadSentry() {
    // One fetch for every caller. A failed fetch is not kept, so the next call tries again.
    loading ??= import('./vendor/sentry-browser.js').then(namespace => {
        Sentry = namespace;
        return namespace;
    }, error => {
        loading = undefined;
        throw error;
    });

    return loading;
}
