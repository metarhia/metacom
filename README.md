# Metacom Communication Protocol for Metarhia

[![ci status](https://github.com/metarhia/metacom/workflows/Testing%20CI/badge.svg)](https://github.com/metarhia/metacom/actions?query=workflow%3A%22Testing+CI%22+branch%3Amaster)
[![snyk](https://snyk.io/test/github/metarhia/metacom/badge.svg)](https://snyk.io/test/github/metarhia/metacom)
[![npm version](https://badge.fury.io/js/metacom.svg)](https://badge.fury.io/js/metacom)
[![npm downloads/month](https://img.shields.io/npm/dm/metacom.svg)](https://www.npmjs.com/package/metacom)
[![npm downloads](https://img.shields.io/npm/dt/metacom.svg)](https://www.npmjs.com/package/metacom)

Metacom protocol specification:
https://github.com/metarhia/Contracts/blob/master/doc/Metacom.md

```js
// Load at frontend
import { Metacom } from './metacom.js';

// Load at backend
const { Metacom } = require('metacom');

// Open connection (both platforms) and make calls
const metacom = Metacom.create('https://domainname.com:8000');
(async () => {
  const { api } = metacom;
  try {
    await metacom.load('auth'); // Load `auth` interface
    await api.auth.status(); // Check session status
  } catch (err) {
    await api.auth.signIn({ login: 'marcus', password: 'marcus' });
  }
  await metacom.load('example'); // Load `example` interface
  const result = api.example.methodName({ arg1, arg2 });
})();
```

## License & Contributors

Copyright (c) 2018-2022 [Metarhia contributors](https://github.com/metarhia/metacom/graphs/contributors).
Metacom is [MIT licensed](./LICENSE).\
Metacom is a part of [Metarhia](https://github.com/metarhia) technology stack.
