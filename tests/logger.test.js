// Registers its methods before any init, so it comes first.
import './before_init.js';
import assert from 'assert';
import Logger from 'meteor/wolas:sentry';
import { environment, dsn, reset } from './harness.js';

describe(`wolas:sentry on the ${environment}`, function() {
    beforeEach(reset);

    // Loaded in this order so each block runs under the init that precedes it.
    require('./levels.test.js');
    require('./method_breadcrumbs.test.js');
    require('./user_tracking.test.js');

    it('rejects unknown levels', function() {
        assert.throws(() => Logger.init({ dsn, levels: ['warn'] }), /unknown levels: warn/);
        assert.throws(() => Logger.init({ dsn, levels: 'error' }), /must be an array/);
    });
});
