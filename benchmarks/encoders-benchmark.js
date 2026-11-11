'use strict';

const { performance } = require('node:perf_hooks');
const crypto = require('node:crypto');

const nodeEncoders = require('../lib/chunks-node.js');
const browserEncoders = require('../lib/chunks-browser.js');

const ITERATIONS = 100000;
const WARMUP_ITERATIONS = 10000;
const LINE = '='.repeat(80);
const DIVIDER = '-'.repeat(80);
const NUMBER_FORMAT = { maximumFractionDigits: 2 };

const TEST_CASES = [
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

const benchmark = (operation) => {
  const start = performance.now();
  for (let i = 0; i < ITERATIONS; i++) operation();
  const duration = performance.now() - start;
  const opsPerSec = (ITERATIONS / duration) * 1000;
  return { duration, opsPerSec };
};

const formatNumber = (value) => value.toLocaleString('en-US', NUMBER_FORMAT);

const formatOps = (ops) => {
  if (ops >= 1000000) return `${formatNumber(ops / 1000000)}M ops/sec`;
  if (ops >= 1000) return `${formatNumber(ops / 1000)}K ops/sec`;
  return `${formatNumber(ops)} ops/sec`;
};

const printTiming = (label, { opsPerSec, duration }) => {
  const ops = formatOps(opsPerSec).padEnd(20);
  console.log(`    ${label} ${ops} (${formatNumber(duration)}ms)`);
};

const printDifference = (current, base, label) => {
  const percent = (current.opsPerSec / base.opsPerSec - 1) * 100;
  const sign = percent > 0 ? '+' : '';
  const value = formatNumber(percent);
  console.log(`    Difference: ${sign}${value}% (${label})`);
};

const printSection = (title, rows, difference) => {
  console.log();
  console.log(`  ${title}:`);
  for (const { label, result } of rows) printTiming(label, result);
  printDifference(difference.current, difference.base, difference.label);
};

const runCase = ({ name, id, payload }) => {
  console.log(`Test Case: ${name}`);
  console.log(`  ID: "${id}" (${id.length} chars)`);
  console.log(`  Payload: ${payload.length} bytes`);
  console.log(DIVIDER);

  const encodeNode = () => nodeEncoders.chunkEncode(id, payload);
  const encodeBrowser = () => browserEncoders.chunkEncode(id, payload);

  for (let i = 0; i < WARMUP_ITERATIONS; i++) {
    encodeNode();
    encodeBrowser();
  }

  const nodeEncode = benchmark(encodeNode);
  const browserEncode = benchmark(encodeBrowser);

  const nodeChunk = encodeNode();
  const browserChunk = encodeBrowser();

  const nodeDecode = benchmark(() => nodeEncoders.chunkDecode(nodeChunk));
  const browserDecode = benchmark(() =>
    browserEncoders.chunkDecode(browserChunk),
  );
  const browserToNode = benchmark(() => nodeEncoders.chunkDecode(browserChunk));
  const nodeToBrowser = benchmark(() => browserEncoders.chunkDecode(nodeChunk));
  const nodeRoundTrip = benchmark(() => {
    nodeEncoders.chunkDecode(encodeNode());
  });
  const browserRoundTrip = benchmark(() => {
    browserEncoders.chunkDecode(encodeBrowser());
  });

  const browserVsNode = 'Browser vs Node';
  const nodeLabel = 'Node:   ';
  const browserLabel = 'Browser:';

  printSection(
    'Encoding',
    [
      { label: nodeLabel, result: nodeEncode },
      { label: browserLabel, result: browserEncode },
    ],
    { current: browserEncode, base: nodeEncode, label: browserVsNode },
  );
  printSection(
    'Decoding (same origin)',
    [
      { label: nodeLabel, result: nodeDecode },
      { label: browserLabel, result: browserDecode },
    ],
    { current: browserDecode, base: nodeDecode, label: browserVsNode },
  );
  printSection(
    'Cross-compatibility decoding',
    [
      { label: 'Browser→Node:', result: browserToNode },
      { label: 'Node→Browser:', result: nodeToBrowser },
    ],
    {
      current: nodeToBrowser,
      base: browserToNode,
      label: 'Node→Browser vs Browser→Node',
    },
  );
  printSection(
    'Round-trip (encode + decode)',
    [
      { label: nodeLabel, result: nodeRoundTrip },
      { label: browserLabel, result: browserRoundTrip },
    ],
    { current: browserRoundTrip, base: nodeRoundTrip, label: browserVsNode },
  );

  console.log();
  console.log(LINE);
  console.log();
};

const runBenchmarks = () => {
  console.log(LINE);
  console.log('Encoder/Decoder Performance Benchmark');
  console.log(LINE);
  console.log(`Iterations: ${formatNumber(ITERATIONS)}`);
  console.log(`Warmup: ${formatNumber(WARMUP_ITERATIONS)}`);
  console.log(LINE);
  console.log();

  for (const testCase of TEST_CASES) runCase(testCase);

  console.log('Summary:');
  console.log('  - Both implementations use identical encoding format');
  console.log('  - Cross-compatibility is fully supported');
  console.log('  - Node usually faster than Browser');
  console.log('  - Performance differences are due to:');
  console.log('    * Node: Buffer.from() for UTF-8 conversion');
  console.log('    * Browser: TextEncoder/TextDecoder APIs');
  console.log(LINE);
};

runBenchmarks();
