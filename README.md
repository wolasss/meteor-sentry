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

# Development

Tests run on the server and in headless Chromium:

```
npm install
npx playwright install chromium
npm test
```
