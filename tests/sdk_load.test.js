import assert from 'assert';
import { createLoader } from 'meteor/wolas:sentry/lib/client_sdk.js';

// An importer that settles each call from the next of the given outcomes.
function fakeImporter(...outcomes) {
    const importer = () => {
        importer.calls += 1;
        const outcome = outcomes.shift();

        return outcome.failure ? Promise.reject(outcome.failure) : Promise.resolve(outcome.namespace);
    };

    importer.calls = 0;

    return importer;
}

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });

    return { promise, resolve, reject };
}

async function rejection(promise) {
    try {
        await promise;
    } catch (error) {
        return error;
    }

    assert.fail('expected the load to reject');
}

describe('Logger.load when the SDK fetch fails', function() {
    const namespace = { captureException() {} };

    it('rejects with the fetch error, and the next call fetches again', async function() {
        const failure = new Error('offline');
        const importer = fakeImporter({ failure }, { namespace });
        const load = createLoader(importer, () => {});

        assert.strictEqual(await rejection(load()), failure);
        assert.strictEqual(await load(), namespace);
        assert.strictEqual(importer.calls, 2);
    });

    it('shares one fetch between callers made before it settles', async function() {
        const failure = new Error('blocked');
        const fetch = deferred();
        let calls = 0;
        const load = createLoader(() => {
            calls += 1;
            return fetch.promise;
        }, () => {});

        const first = load();
        const second = load();

        assert.strictEqual(first, second);
        assert.strictEqual(calls, 1);

        fetch.reject(failure);

        assert.strictEqual(await rejection(first), failure);
        assert.strictEqual(await rejection(second), failure);
        assert.strictEqual(calls, 1);
    });

    it('hands over the SDK only on success', async function() {
        const failure = new Error('server restarting');
        const loaded = [];
        const load = createLoader(fakeImporter({ failure }, { namespace }), loadedNamespace => {
            loaded.push(loadedNamespace);
        });

        await rejection(load());
        assert.deepStrictEqual(loaded, []);

        await load();
        assert.strictEqual(loaded.length, 1);
        assert.strictEqual(loaded[0], namespace);
    });

    it('keeps a successful fetch for every later call', async function() {
        const importer = fakeImporter({ namespace });
        const load = createLoader(importer, () => {});

        assert.strictEqual(await load(), namespace);
        assert.strictEqual(await load(), namespace);
        assert.strictEqual(await load(), namespace);
        assert.strictEqual(importer.calls, 1);
    });

    it('turns an importer that throws into a rejection, and the next call fetches again', async function() {
        const failure = new Error('thrown');
        let calls = 0;
        const load = createLoader(() => {
            calls += 1;

            if (calls === 1) {
                throw failure;
            }

            return Promise.resolve(namespace);
        }, () => {});

        const first = load();

        assert.ok(first instanceof Promise);
        assert.strictEqual(await rejection(first), failure);
        assert.strictEqual(await load(), namespace);
        assert.strictEqual(calls, 2);
    });
});
