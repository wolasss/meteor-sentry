# wolas:sentry

This package is a wrapper for sentry library. It allows you to simply use latest Sentry SDK on both client and a server in your meteor application.

This package is MIT Licensed.

# Installation

```
    meteor add wolas:sentry
```

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

**Returns**: <code>string</code> - sentry event id.

| Param | Type | Description |
| --- | --- | --- |
| event | <code>Error</code> \ <code>string</code> | event that is being logged |
| extra | <code>object</code> | any extra params you want to pass |

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
