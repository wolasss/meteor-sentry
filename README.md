# wolas:sentry

[![semantic-release](https://img.shields.io/badge/%20%20%F0%9F%93%A6%F0%9F%9A%80-semantic--release-e10079.svg)](https://github.com/semantic-release/semantic-release)


This package is a wrapper for sentry library. It allows you to simply use latest Sentry SDK on both client and a server in your meteor application.

This package is MIT Licensed.

# Requirements

- 2.x: Meteor 3.0 or newer (Sentry SDK 11 needs Node 20.19 or newer).
- Meteor 2: stay on 1.x.

# Installation

```
meteor add wolas:sentry
```

# Upgrading from 1.x to 2.x

2.x ships Sentry SDK 11. Read the [Sentry migration guide](https://github.com/getsentry/sentry-javascript/blob/develop/MIGRATION.md) for the full list. The changes most likely to affect you:

- **More data collected by default.** `sendDefaultPii` is replaced by `dataCollection`, and leaving it unset now collects user info, cookies, request bodies and database queries. To keep the old, stricter behaviour, pass `dataCollection` to `Logger.init` (see the guide).
- **Stack traces on messages.** `attachStacktrace` now defaults to `true`, so `Logger.info('...')` and friends carry a stack trace. Issue grouping may change. Pass `attachStacktrace: false` to opt out.
- **Unhandled server exceptions** are now reported by Sentry's own handler, as `fatal` and unhandled. The server process still exits, as before.
- **`info`, `debug` and `log` calls no longer reach Sentry by default.** They still run `postprocess`. To keep sending them, pass `levels` to `Logger.init` (see [Choosing which levels reach Sentry](#choosing-which-levels-reach-sentry-clientserver)).
- **`Logger.critical()` is sent as `fatal`**, because Sentry 11 has no `critical` level. Alert rules that matched `critical` need to match `fatal`.

# Usage

The same interface can be used on a client and server.

## Initialization (client/server)

```
import Logger from 'meteor/wolas:sentry';

Logger.init({
    dsn: YOUR_SENTRY_DSN GOES HERE

    //any other options you want to pass to sentry init function
});
```

## Logging events (client/server)

```
import Logger from 'meteor/wolas:sentry';

Logger.info('Something happened', {
    userId: getUserId()
});
```

Logger has methods for all Sentry severity levels, such as:

```
Logger.error()
Logger.fatal()
Logger.warning()
Logger.info()
Logger.debug()
Logger.critical()
```

Sentry has no `critical` level, so `Logger.critical()` reaches Sentry as `fatal`. `postprocess` still receives `critical`.

each method has following signature:

`function ( event, extra )`

**Returns**: <code>string</code> \ <code>undefined</code> - sentry event id, or `undefined` when the level is not sent.

| Param | Type | Description |
| --- | --- | --- |
| event | <code>Error</code> \ <code>string</code> | event that is being logged |
| extra | <code>object</code> | any extra params you want to pass |

## Choosing which levels reach Sentry (client/server)

By default only `fatal`, `error`, `warning` and `critical` are sent. Other levels still run `postprocess`, so you can keep them in your console without paying for them in Sentry. A level that is not sent returns `undefined` instead of an event id.

Pass `levels` to choose your own list:

```
Logger.init({
    dsn: YOUR_SENTRY_DSN GOES HERE,
    levels: ['fatal', 'error', 'warning', 'critical', 'info']
});
```

This only applies to `Logger` calls. Events Sentry captures by itself, such as unhandled exceptions, are always sent. Use Sentry's `beforeSend` to filter those.

## Logging unhandled exceptions (client/server)

Any unhandled exceptions that happen on the client or server should be automatically logged to Sentry. Nothing to configure there.

## Server context (server)

Every `Logger` call on the server, and every error `captureMethodErrors` reports, is tagged with what was running at the time, with no extra code:

- `meteor.method` - the name of the Meteor method, or
- `meteor.publication` - the name of the publication,
- `user.id` - the id of the user who called it, when someone is logged in.

Events logged outside any method or publication, for example in `Meteor.startup` or a timer, carry none of these and look exactly as before. So do events Sentry captures by itself, such as unhandled exceptions.

## Reporting method errors (server)

Meteor catches an error thrown inside a method and sends it to the client, so Sentry never sees it. Turn on `captureMethodErrors` to report it:

```
Logger.init({
    dsn: YOUR_SENTRY_DSN GOES HERE,
    captureMethodErrors: true
});
```

Each error is reported once, with the same method tag and user as above, then rethrown unchanged, so the client gets exactly what it got before. It works for sync and async methods, registered before or after `Logger.init`.

Errors that are `instanceof Meteor.Error` are not reported. A `Meteor.Error` is the method's intended answer to the client, such as a validation failure or a permission denial, not a crash.

## Client options (client)

```
Logger.init({
    dsn: YOUR_SENTRY_DSN GOES HERE,
    trackUsers: true,
    methodBreadcrumbs: true
});
```

- `trackUsers` (default `true`) - attaches the signed-in user's email to every event. Needs `accounts-base`.
- `methodBreadcrumbs` (default `true`) - adds a `meteor.method` breadcrumb named after each `Meteor.call`, `Meteor.callAsync`, `Meteor.apply` and `Meteor.applyAsync`, so an event shows which methods ran before it. Method arguments are never included, as they can hold passwords. Pass `false` to turn it off, also after an earlier `Logger.init`.

## Postprocessing (client/server)

If you wish to postprocess an event somehow - for instance log it to the console, you can pass a custom function in initialization.

```
import Logger from 'meteor/wolas:sentry';

Logger.init({
    dsn: YOUR_SENTRY_DSN GOES HERE,
    postprocess: function(level, event, extra) {
        console.log(`[${level}] - ${event}`, extra);
    }
});
```

A `postprocess` hook that throws never breaks the logging call: the call still returns what it would have returned for that level (the event id, or `undefined` for a level that is not sent), and the hook's error is written to `console.error`.

# Development

Tests run on the server and in headless Chromium:

```
npm install
npx playwright install chromium
npm test
```

Dependabot only sees the dev tooling in `package-lock.json`, not the Sentry packages Meteor locks in `.npm/package/npm-shrinkwrap.json`. CI checks those on every push and nightly:

```
npm run audit:runtime
```

Advisories that cannot affect this package go in `scripts/runtime-audit-allowlist.json` with a reason and an expiry date.

## Commits

Commit messages follow the conventional format, `type(scope): subject`, for example `fix(client): clear the Sentry user on logout`. `npm install` installs a husky `commit-msg` hook that runs commitlint with `@commitlint/config-conventional`, and it rejects any other message. The accepted types are `build`, `chore`, `ci`, `docs`, `feat`, `fix`, `perf`, `refactor`, `revert`, `style` and `test`.

The type decides the next release: `feat` is a minor release; `fix`, `perf`, `docs`, `chore`, `refactor` and a revert are a patch; `build`, `ci`, `style` and `test` release nothing on their own. A `BREAKING CHANGE:` footer makes a major release whatever the type. The `!` shorthand (`feat!:`) passes commitlint but the release tooling does not read it, so a breaking commit needs the footer as well.

## Releasing

Releases are cut by hand on `master` with `npm run release`, which runs semantic-release. Its config sets `ci: false`, so CI never releases. It needs push access to `master`; there is no GitHub plugin and no token.

A run reads the commits since the last tag, writes the release notes to `CHANGELOG.md`, bumps `version` in `package.json` (nothing is published to npm, `npmPublish: false`), then commits and tags the result.

`package.js` carries the Atmosphere version, and semantic-release does not touch it. Bump it by hand to match the new tag, then publish to Atmosphere with `meteor publish`.
