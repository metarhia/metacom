# Changelog

## [Unreleased][unreleased]

- Implement metacom3 specs: https://github.com/metarhia/Contracts/blob/master/doc/Metacom.md
- Refactor streams
- Optimize chunk encoding

## [3.0.0-alpha.8][] - 2023-02-13

- Fix server-side client
- Unify server-side and browser `streams` implementation
- Update metautil to 3.7.1 for fixed `fetch`
- Unify `EventEmitter` implementation

## [3.0.0-alpha.7][] - 2023-02-09

- Add `node:` prefix for all internal modules
- Generate UUID for each RPC call to track logic
- Add `Context` and `State` classes
- Fix typings: remove internal module classes, add some exported
- Change contracts `Client` and `Channel`

## [3.0.0-alpha.6][] - 2023-02-13

- Fix `httpCall` for `Client`
- Fix `close` event call for `Client` instance on `Channel` destroy

## [3.0.0-alpha.5][] - 2022-12-23

- Move `serveStatic` to impress
- Fix path separaton in url for windows
- Fix serving static files
- Use `fetch` polyfill from metautil
- Optimize abstractions
- Update dependencies

## [3.0.0-alpha.4][] - 2022-07-30

- Package maintenance

## [3.0.0-alpha.3][] - 2022-07-26

- Add metacom binary streams
  - Event emitter based
  - Websocket bidirectional streaming
  - Multiple simultaneous streams
  - Interaction with nodejs streams
  - File streaming
- Implement metacom stream protocol
  - Stream initialization
  - Stream closing
  - Stream termination
  - Chunk identification with metadata header
- Api interfaces
  - Stream consumers
  - Stream producers
- Add stream types
- Fix browser client WebsocketTransport open
- Add method for a possibility to delete session token from the application routes
- Fix serve static files with query in URL

## [3.0.0-alpha.2][] - 2022-07-07

- Pass http verb to the hook
- Package meintenance

## [3.0.0-alpha.1][] - 2022-05-16

- Pass certain port for `Server` in `options`, do not pass `threadId`

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

[unreleased]: https://github.com/metarhia/metacom/compare/v3.0.0-alpha.8...HEAD
[3.0.0-alpha.8]: https://github.com/metarhia/metacom/compare/v3.0.0-alpha.7...v3.0.0-alpha.8
[3.0.0-alpha.7]: https://github.com/metarhia/metacom/compare/v3.0.0-alpha.6...v3.0.0-alpha.7
[3.0.0-alpha.6]: https://github.com/metarhia/metacom/compare/v3.0.0-alpha.5...v3.0.0-alpha.6
[3.0.0-alpha.5]: https://github.com/metarhia/metacom/compare/v3.0.0-alpha.4...v3.0.0-alpha.5
[3.0.0-alpha.4]: https://github.com/metarhia/metacom/compare/v3.0.0-alpha.3...v3.0.0-alpha.4
[3.0.0-alpha.3]: https://github.com/metarhia/metacom/compare/v3.0.0-alpha.2...v3.0.0-alpha.3
[3.0.0-alpha.2]: https://github.com/metarhia/metacom/compare/v3.0.0-alpha.1...v3.0.0-alpha.2
[3.0.0-alpha.1]: https://github.com/metarhia/metacom/compare/v2.0.7...v3.0.0-alpha.1
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
