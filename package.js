Package.describe({
  name: 'wolas:sentry',
  version: '1.0.11',
  summary: 'A simple wrapper for sentry SDK. Allows to use sentry in both client and server in meteor apps.',
  git: 'https://github.com/wolasss/meteor-sentry',
  documentation: 'README.md'
});

Npm.depends({
  '@sentry/browser': '8.26.0',
  '@sentry/node': '7.119.0'
});

Package.onUse(function(api) {
  api.versionsFrom('1.8.1');
  api.use('ecmascript');
  api.addFiles('lib/client.js', 'client');
  api.addFiles('lib/server.js', 'server');
  api.mainModule('lib/logger_client.js', 'client');
  api.mainModule('lib/logger_server.js', 'server');
});
