# Changelog

## [Unreleased][unreleased]

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

[unreleased]: https://github.com/metarhia/metacom/compare/v1.5.2...HEAD
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
