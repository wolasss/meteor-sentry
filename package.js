Package.describe({
  name: 'wolas:sentry',
  version: '1.0.3',
  summary: 'A simple wrapper for sentry SDK. Allows to use sentry in both client and server in meteor apps.',
  git: 'https://github.com/wolasss/meteor-sentry',
  documentation: 'README.md'
});

Npm.depends({
  '@sentry/browser': '5.13.0',
  '@sentry/node': '5.13.1'
});

Package.onUse(function(api) {
  api.versionsFrom('1.8.1');
  api.use('ecmascript');
  api.addFiles('lib/client.js', 'client');
  api.addFiles('lib/server.js', 'server');
  api.mainModule('lib/logger.js');
});
