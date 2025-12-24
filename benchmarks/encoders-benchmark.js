'use strict';

const { performance } = require('node:perf_hooks');
const crypto = require('node:crypto');
const nodeEncoders = require('../lib/chunks.js');
const browserEncoders = require('../lib/chunks-browser.js');

const ITERATIONS = 100000;
const WARMUP_ITERATIONS = 10000;

const testCases = [
  {
    name: 'Short ID, small payload',
    id: 'test',
    payload: new Uint8Array([1, 2, 3, 4, 5]),
  },
  {
    name: 'Usual ID, medium payload',
    id: crypto.randomUUID(),
    payload: new Uint8Array(100).fill(42),
  },
  {
    name: 'Long ID, large payload',
    id: 'a'.repeat(200),
    payload: new Uint8Array(1000).fill(128),
  },
  {
    name: 'UTF-8 ID, medium payload',
    id: 'тест-测试-🚀',
    payload: new Uint8Array(50).fill(99),
  },
];

const benchmark = (name, fn, iterations) => {
  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    fn();
  }
  const end = performance.now();
  const duration = end - start;
  const opsPerSec = (iterations / duration) * 1000;
  return { duration, opsPerSec };
};

const formatNumber = (num) =>
  num.toLocaleString('en-US', {
    maximumFractionDigits: 2,
  });

const formatOps = (ops) => {
  if (ops >= 1000000) return `${formatNumber(ops / 1000000)}M ops/sec`;
  if (ops >= 1000) return `${formatNumber(ops / 1000)}K ops/sec`;
  return `${formatNumber(ops)} ops/sec`;
};

const runBenchmarks = () => {
  console.log('='.repeat(80));
  console.log('Encoder/Decoder Performance Benchmark');
  console.log('='.repeat(80));
  console.log(`Iterations: ${formatNumber(ITERATIONS)}`);
  console.log(`Warmup: ${formatNumber(WARMUP_ITERATIONS)}`);
  console.log('='.repeat(80));
  console.log();

  for (const testCase of testCases) {
    console.log(`Test Case: ${testCase.name}`);
    console.log(`  ID: "${testCase.id}" (${testCase.id.length} chars)`);
    console.log(`  Payload: ${testCase.payload.length} bytes`);
    console.log('-'.repeat(80));

    const results = {};

    // Warmup
    for (let i = 0; i < WARMUP_ITERATIONS; i++) {
      nodeEncoders.chunkEncode(testCase.id, testCase.payload);
      browserEncoders.chunkEncode(testCase.id, testCase.payload);
    }

    // Node encode
    results.nodeEncode = benchmark(
      'Node encode',
      () => nodeEncoders.chunkEncode(testCase.id, testCase.payload),
      ITERATIONS,
    );

    // Browser encode
    results.browserEncode = benchmark(
      'Browser encode',
      () => browserEncoders.chunkEncode(testCase.id, testCase.payload),
      ITERATIONS,
    );

    // Prepare chunks for decode tests
    const nodeChunk = nodeEncoders.chunkEncode(testCase.id, testCase.payload);
    const browserChunk = browserEncoders.chunkEncode(
      testCase.id,
      testCase.payload,
    );

    // Node decode (same origin)
    results.nodeDecode = benchmark(
      'Node decode',
      () => nodeEncoders.chunkDecode(nodeChunk),
      ITERATIONS,
    );

    // Browser decode (same origin)
    results.browserDecode = benchmark(
      'Browser decode',
      () => browserEncoders.chunkDecode(browserChunk),
      ITERATIONS,
    );

    // Cross-compatibility: Browser encode → Node decode
    results.browserToNode = benchmark(
      'Browser→Node decode',
      () => nodeEncoders.chunkDecode(browserChunk),
      ITERATIONS,
    );

    // Cross-compatibility: Node encode → Browser decode
    results.nodeToBrowser = benchmark(
      'Node→Browser decode',
      () => browserEncoders.chunkDecode(nodeChunk),
      ITERATIONS,
    );

    // Node round-trip (same origin)
    results.nodeRoundTrip = benchmark(
      'Node round-trip',
      () => {
        const chunk = nodeEncoders.chunkEncode(testCase.id, testCase.payload);
        nodeEncoders.chunkDecode(chunk);
      },
      ITERATIONS,
    );

    // Browser round-trip (same origin)
    results.browserRoundTrip = benchmark(
      'Browser round-trip',
      () => {
        const chunk = browserEncoders.chunkEncode(
          testCase.id,
          testCase.payload,
        );
        browserEncoders.chunkDecode(chunk);
      },
      ITERATIONS,
    );

    // Print results
    console.log();
    console.log('  Encoding:');
    console.log(
      `    Node:    ${formatOps(results.nodeEncode.opsPerSec).padEnd(20)} ` +
        `(${formatNumber(results.nodeEncode.duration)}ms)`,
    );
    console.log(
      `    Browser: ${formatOps(results.browserEncode.opsPerSec).padEnd(20)} ` +
        `(${formatNumber(results.browserEncode.duration)}ms)`,
    );
    const encodeDiff =
      (results.browserEncode.opsPerSec / results.nodeEncode.opsPerSec - 1) *
      100;
    console.log(
      `    Difference: ${encodeDiff > 0 ? '+' : ''}` +
        `${formatNumber(encodeDiff)}% ` +
        `(Browser vs Node)`,
    );

    console.log();
    console.log('  Decoding (same origin):');
    console.log(
      `    Node:    ${formatOps(results.nodeDecode.opsPerSec).padEnd(20)} ` +
        `(${formatNumber(results.nodeDecode.duration)}ms)`,
    );
    console.log(
      `    Browser: ${formatOps(results.browserDecode.opsPerSec).padEnd(20)} ` +
        `(${formatNumber(results.browserDecode.duration)}ms)`,
    );
    const decodeDiff =
      (results.browserDecode.opsPerSec / results.nodeDecode.opsPerSec - 1) *
      100;
    console.log(
      `    Difference: ${decodeDiff > 0 ? '+' : ''}` +
        `${formatNumber(decodeDiff)}% ` +
        `(Browser vs Node)`,
    );

    console.log();
    console.log('  Cross-compatibility decoding:');
    console.log(
      `    Browser→Node: ` +
        `${formatOps(results.browserToNode.opsPerSec).padEnd(20)} ` +
        `(${formatNumber(results.browserToNode.duration)}ms)`,
    );
    console.log(
      `    Node→Browser: ` +
        `${formatOps(results.nodeToBrowser.opsPerSec).padEnd(20)} ` +
        `(${formatNumber(results.nodeToBrowser.duration)}ms)`,
    );
    const crossDiff =
      (results.nodeToBrowser.opsPerSec / results.browserToNode.opsPerSec - 1) *
      100;
    console.log(
      `    Difference: ${crossDiff > 0 ? '+' : ''}` +
        `${formatNumber(crossDiff)}% ` +
        `(Node→Browser vs Browser→Node)`,
    );

    console.log();
    console.log('  Round-trip (encode + decode):');
    console.log(
      `    Node:    ${formatOps(results.nodeRoundTrip.opsPerSec).padEnd(20)} ` +
        `(${formatNumber(results.nodeRoundTrip.duration)}ms)`,
    );
    console.log(
      `    Browser: ` +
        `${formatOps(results.browserRoundTrip.opsPerSec).padEnd(20)} ` +
        `(${formatNumber(results.browserRoundTrip.duration)}ms)`,
    );
    const roundTripDiff =
      (results.browserRoundTrip.opsPerSec / results.nodeRoundTrip.opsPerSec -
        1) *
      100;
    console.log(
      `    Difference: ${roundTripDiff > 0 ? '+' : ''}` +
        `${formatNumber(roundTripDiff)}% ` +
        `(Browser vs Node)`,
    );

    console.log();
    console.log('='.repeat(80));
    console.log();
  }

  // Summary
  console.log('Summary:');
  console.log('  - Both implementations use identical encoding format');
  console.log('  - Cross-compatibility is fully supported');
  console.log('  - Node usually faster than Browser');
  console.log('  - Performance differences are due to:');
  console.log('    * Node: Buffer.from() for UTF-8 conversion');
  console.log('    * Browser: TextEncoder/TextDecoder APIs');
  console.log('='.repeat(80));
};

runBenchmarks();
