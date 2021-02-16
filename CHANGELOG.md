# Changelog

## [Unreleased][unreleased]

- Fix error passing to client side

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

[unreleased]: https://github.com/metarhia/metacom/compare/v1.3.1...HEAD
[1.3.1]: https://github.com/metarhia/metacom/compare/v1.3.0...v1.3.1
[1.3.0]: https://github.com/metarhia/metacom/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/metarhia/metacom/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/metarhia/metacom/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/metarhia/metacom/compare/v0.0.0...v1.0.0
[0.0.0]: https://github.com/metarhia/metacom/releases/tag/v0.0.0
