Package.describe({
  name: 'wolas:sentry',
  version: '3.0.0',
  summary: 'A simple wrapper for sentry SDK. Allows to use sentry in both client and server in meteor apps.',
  git: 'https://github.com/wolasss/meteor-sentry',
  documentation: 'README.md'
});

// The client's SDK is bundled into lib/vendor from the @sentry/browser in
// package.json devDependencies, which must stay at this version.
Npm.depends({
  '@sentry/node': '11.10.0'
});

Package.onUse(function(api) {
  api.versionsFrom('3.0');
  api.use('ecmascript');
  api.use('ddp', 'server');
  api.addFiles('lib/client.js', 'client');
  api.addFiles('lib/server.js', 'server');
  api.mainModule('lib/logger_client.js', 'client');
  api.mainModule('lib/logger_server.js', 'server');
});

Package.onTest(function(api) {
  api.use(['ecmascript', 'ddp', 'meteortesting:mocha', 'wolas:sentry']);
  api.addFiles('tests/reinit.test.js');
  api.mainModule('tests/logger.test.js');
});
