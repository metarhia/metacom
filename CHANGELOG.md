# Changelog

## [Unreleased][unreleased]

## [3.2.1][] - 2024-02-12

- Added call limits with queue to hooks
- Fix conversion of custom thrown exceptions for response to client
- Update dependencies

## [3.2.0][] - 2023-12-10

- Remove `EventEmitter` polyfill, use polyfill from metautil 5.0.0
- Stop using deprecated `fetch` polyfill from metautil
- Do not add `online` event if we have no `window`
- Implement simple websocket server
- Fixed MetaReadable stream
- Fixed timeouts in unittests
- Package maintenance: update dependencies and eslint and CI configs

## [3.1.2][] - 2023-10-22

- Fix: proc timeout reached error detection

## [3.1.1][] - 2023-10-09

- Fix: do not serve API over http and ws on balancing port

## [3.1.0][] - 2023-10-06

- Decompose bind to init and listen to handle EADDRINUSE and escalate error
- Fix buffer length calculation for unicode strings
- Drop node.js 16 and 19 and update dependencies

## [3.0.6][] - 2023-09-13

- Log requests to static
- Template pages for HTTP errors

## [3.0.5][] - 2023-09-08

- Check static handler class
- Update dependencies

## [3.0.4][] - 2023-08-20

- Bugfixes: event packets parsing and prevent echo

## [3.0.3][] - 2023-08-19

- Bugfixes: sendEvent call, checking http or ws transport

## [3.0.2][] - 2023-08-14

- Bugfixes: MetaReadable, binary packages parsing and serialization
- Refactoring: Transport API unification

## [3.0.1][] - 2023-06-22

- Add `MetacomUnit` method `post` not emitting `*`
- Fix invalid event packets parsing in server client
- Package maintenance: update code style and dependencies

## [3.0.0][] - 2023-06-30

- Implement metacom3 specs: https://github.com/metarhia/Contracts/blob/master/doc/Metacom.md
- Implement metacom streams
  - Websocket bidirectional streaming
  - Multiple simultaneous streams
  - Interaction with nodejs streams
  - File streaming
- Pass certain port for `Server` in `options`, do not pass `threadId`
- Generate UUID for each RPC call to track logic
- Add `Context` and `State` classes
- Change contracts `Client` and `Channel`
- Fix setTimeout and setInterval leaks
- Support pipe readable (for large files)
- Support SNI callback for TLS transport
- Support Content-Range, Accept-Ranges, Content-Length headers
- Move `serveStatic` to impress
- Serve static from balancing port
- Use `fetch` polyfill from metautil
- Convert package_lock.json to lockfileVersion 2
- Unify `EventEmitter` implementation
- Drop node.js 14 support, add node.js 20
- Add `node:` prefix for all internal modules
- Update dependencies

## [2.0.7][] - 2022-05-09

- Fix client to support falsy results parsing
- Add reading cors.origin from server config in impress
- Removed duplicated error handling
- Remove duplicated EventEmitter in MetacomInterface

## [2.0.6][] - 2022-04-26

- Fix missing channel handling in Client
- Fix default `httpCode` in `Channel#error()` calls
- Add custom http headers for rpc hooks
- Prevent return after semaphore enter

## [2.0.5][] - 2022-03-18

- Fix clients Map memory leak
- Add static create method for server-side Client
- Add open and close events in browser-side Client
- Add common content types (MIME) to collection
- Pass custom errors with `code` thrown or returned from handlers
- Update dependencies

## [2.0.4][] - 2021-10-12

- Return index.html not only from the root folder
- Fix parse broken JSON packets
- Fix detecting ping packets (empty objects)
- Fix error logging and passing to client
- Validation `call` identifier type

## [2.0.3][] - 2021-09-23

- Remove `toString` in `receiveBody` to be compatible with ws

## [2.0.2][] - 2021-09-11

- Rework Channel and Server
  - Decompose Channel to WsChannel and HttpChannel
  - Move event handlers from Server to WsChannel and HttpChannel
  - Return after error to avoid double reply and logging
  - Update typings

## [2.0.1][] - 2021-09-03

- Simplify Channel/Session machinery
  - Collections: sessions, channels
  - Decompose: extract transport and static modules
- Fix: empty packet structure error

## [2.0.0][] - 2021-08-19

- Support GET requests and change calls: `hook` and `invoke`
- Add `redirect` method to `Client` with delegation to `Channel`
- Update dependencies

## [1.8.2][] - 2021-08-06

- Rewrite `Client` method `startSession` and `restoreSession` to remove access
  to `auth.provider` and work with database structure, move this to application
  leyer where we `know` auth specific DB structure
- Move types to package root

## [1.8.1][] - 2021-07-10

- Move split and parseParams to metautil
- Fix custom errors over http transport
- Remove timeout in Server duplicated in rpc call (Procedure class)

## [1.8.0][] - 2021-07-07

- Add http hooks with custom method names
- Fix Metacom typings
- Improve url parsing

## [1.7.5][] - 2021-07-01

- Fix Metacom typings
- Update dependencies

## [1.7.4][] - 2021-06-26

- Update Metacom exports
- Throw errors on wrong configs
- Update Client implementation in /distr

## [1.7.3][] - 2021-06-08

- Fix passing validation error to the client

## [1.7.2][] - 2021-06-06

- Move @types/ws to dev dependencies to reduce prod module size

## [1.7.1][] - 2021-06-03

- Update dependencies for security reasons

## [1.7.0][] - 2021-05-24

- Fix method access check
- Rename id field to support new auth

## [1.6.1][] - 2021-04-13

- Fix and improve typings
- Publish typings to npm package

## [1.6.0][] - 2021-03-15

- Implement port re-bind
- Disable Nagle's algorithm if configured
- Read timeouts from config (remove hardcoded constants)
- Refactor and improve code style
- Add typing for Metacom class

## [1.5.3][] - 2021-02-28

- Marshal timeout error to the client side
- Get user ip from Client class: `context.client.ip`
- Change queue configuration: https://github.com/metarhia/impress/issues/1484

## [1.5.2][] - 2021-02-23

- Update metautil to 3.5.0, change `await timeout` to `await delay`
- Remove channel from collection on connections close
- Add Client event: 'close' for http and websockets
- Delegate server and browser socket on 'error' handler

## [1.5.1][] - 2021-02-19

- Fix restore session for Channel

## [1.5.0][] - 2021-02-19

- Move Semaphore and timeout to metautil
- Decompose Channel.prototype.rpc
- Use new impress class Procedure

## [1.4.0][] - 2021-02-17

- Fix error passing to client side
- Call application.invoke to execute methods with schema validation
- Don't pass context to `application.getMethod`
  - Pass context to application.invoke
  - Now proc is a struct, not just method with injected context

## [1.3.1][] - 2021-02-09

- Revert to lock-file version 1
- Fix memory leak: remove sessions from collection by token

## [1.3.0][] - 2021-02-07

- Fix channel collection memory leak and duplication
- Change `Server` constrictor signature to `(config, application)`
- Fix spelling in method: Channel.startSession

## [1.2.0][] - 2021-02-04

- Move cookies operations from impress/auth
- Move sessions from impress/auth

## [1.1.0][] - 2021-01-08

- Use metautil instead of metarhia/common

## [1.0.0][] - 2020-12-21

- Metacom protocol implementation for client and server
- Support ws, wss, http and https transports
- Automatic reconnect on network errors or disconnect
- Server-side introspection and Client-side scaffolding
- Domain errors passing to browser client code
- Support ping interval (default 60s) and call timeout (default 7s)
- Reconnect active connections on browser `onlene` event

## [0.0.0][] - 2018-04-14

Module stub v0.0.0 and all before 1.0.0 are experiments with syntactic and
binary structures and multiple different ideas originated from JSTP and old
protocols like USP and CLEAR.

[unreleased]: https://github.com/metarhia/metacom/compare/v3.2.1...HEAD
[3.2.1]: https://github.com/metarhia/metacom/compare/v3.2.0...v3.2.1
[3.2.0]: https://github.com/metarhia/metacom/compare/v3.1.2...v3.2.0
[3.1.2]: https://github.com/metarhia/metacom/compare/v3.1.1...v3.1.2
[3.1.1]: https://github.com/metarhia/metacom/compare/v3.1.0...v3.1.1
[3.1.0]: https://github.com/metarhia/metacom/compare/v3.0.6...v3.1.0
[3.0.6]: https://github.com/metarhia/metacom/compare/v3.0.5...v3.0.6
[3.0.5]: https://github.com/metarhia/metacom/compare/v3.0.4...v3.0.5
[3.0.4]: https://github.com/metarhia/metacom/compare/v3.0.3...v3.0.4
[3.0.3]: https://github.com/metarhia/metacom/compare/v3.0.2...v3.0.3
[3.0.2]: https://github.com/metarhia/metacom/compare/v3.0.1...v3.0.2
[3.0.1]: https://github.com/metarhia/metacom/compare/v3.0.0...v3.0.1
[3.0.0]: https://github.com/metarhia/metacom/compare/v2.0.7...v3.0.0
[2.0.7]: https://github.com/metarhia/metacom/compare/v2.0.6...v2.0.7
[2.0.6]: https://github.com/metarhia/metacom/compare/v2.0.5...v2.0.6
[2.0.5]: https://github.com/metarhia/metacom/compare/v2.0.4...v2.0.5
[2.0.4]: https://github.com/metarhia/metacom/compare/v2.0.3...v2.0.4
[2.0.3]: https://github.com/metarhia/metacom/compare/v2.0.2...v2.0.3
[2.0.2]: https://github.com/metarhia/metacom/compare/v2.0.1...v2.0.2
[2.0.1]: https://github.com/metarhia/metacom/compare/v2.0.0...v2.0.1
[2.0.0]: https://github.com/metarhia/metacom/compare/v1.8.1...v2.0.0
[1.8.2]: https://github.com/metarhia/metacom/compare/v1.8.1...v1.8.2
[1.8.1]: https://github.com/metarhia/metacom/compare/v1.8.0...v1.8.1
[1.8.0]: https://github.com/metarhia/metacom/compare/v1.7.5...v1.8.0
[1.7.5]: https://github.com/metarhia/metacom/compare/v1.7.4...v1.7.5
[1.7.4]: https://github.com/metarhia/metacom/compare/v1.7.3...v1.7.4
[1.7.3]: https://github.com/metarhia/metacom/compare/v1.7.2...v1.7.3
[1.7.2]: https://github.com/metarhia/metacom/compare/v1.7.1...v1.7.2
[1.7.1]: https://github.com/metarhia/metacom/compare/v1.7.0...v1.7.1
[1.7.0]: https://github.com/metarhia/metacom/compare/v1.6.1...v1.7.0
[1.6.1]: https://github.com/metarhia/metacom/compare/v1.6.0...v1.6.1
[1.6.0]: https://github.com/metarhia/metacom/compare/v1.5.3...v1.6.0
[1.5.3]: https://github.com/metarhia/metacom/compare/v1.5.2...v1.5.3
[1.5.2]: https://github.com/metarhia/metacom/compare/v1.5.1...v1.5.2
[1.5.1]: https://github.com/metarhia/metacom/compare/v1.5.0...v1.5.1
[1.5.0]: https://github.com/metarhia/metacom/compare/v1.4.0...v1.5.0
[1.4.0]: https://github.com/metarhia/metacom/compare/v1.3.1...v1.4.0
[1.3.1]: https://github.com/metarhia/metacom/compare/v1.3.0...v1.3.1
[1.3.0]: https://github.com/metarhia/metacom/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/metarhia/metacom/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/metarhia/metacom/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/metarhia/metacom/compare/v0.0.0...v1.0.0
[0.0.0]: https://github.com/metarhia/metacom/releases/tag/v0.0.0
