'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DIR = path.join(ROOT, 'candidates');
const STATUSES = new Set(['draft', 'exploratory', 'approved', 'randomized', 'retired']);
const REQUIRED = [
  'schemaVersion', 'id', 'name', 'status', 'origin', 'authors', 'hypothesis',
  'parameters', 'threatModel', 'benefits', 'tradeoffs', 'acceptanceCriteria',
  'reproduction', 'integrity', 'evidence', 'decision',
];
const METRICS = ['success', 'stability', 'meanBt', 'orphans', 'deepestReorg', 'worstGap', 'diffSwing'];

function fail(file, message) {
  throw new Error(`${path.relative(ROOT, file)}: ${message}`);
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (err) { fail(file, `invalid JSON (${err.message})`); }
}

readJson(path.join(DIR, 'schema.json'));
const files = fs.readdirSync(DIR)
  .filter((name) => name.endsWith('.json') && name !== 'schema.json')
  .sort();

if (!files.length) throw new Error('candidates/: no candidate JSON files found');

const ids = new Set();
for (const name of files) {
  const file = path.join(DIR, name);
  const candidate = readJson(file);
  for (const key of REQUIRED) {
    if (!(key in candidate)) fail(file, `missing required field "${key}"`);
  }
  if (candidate.schemaVersion !== 1) fail(file, 'schemaVersion must be 1');
  if (!/^[a-z][a-z0-9_]{2,47}$/.test(candidate.id)) fail(file, 'invalid immutable id');
  if (name !== `${candidate.id}.json`) fail(file, 'filename must match candidate id');
  if (ids.has(candidate.id)) fail(file, 'duplicate candidate id');
  ids.add(candidate.id);
  if (!STATUSES.has(candidate.status)) fail(file, `unknown status "${candidate.status}"`);
  if (!['community', 'builtin'].includes(candidate.origin)) fail(file, 'origin must be community or builtin');
  if (!Array.isArray(candidate.authors) || !candidate.authors.length
      || candidate.authors.some((author) => !/^@[A-Za-z0-9-]+$/.test(author))) {
    fail(file, 'authors must contain GitHub handles');
  }
  for (const key of ['threatModel', 'benefits', 'tradeoffs']) {
    if (!Array.isArray(candidate[key]) || !candidate[key].length) fail(file, `${key} must be non-empty`);
  }
  if (!candidate.parameters || typeof candidate.parameters !== 'object'
      || Array.isArray(candidate.parameters) || !Object.keys(candidate.parameters).length) {
    fail(file, 'parameters must be a non-empty object');
  }
  for (const metric of METRICS) {
    if (typeof candidate.acceptanceCriteria?.[metric] !== 'string'
        || !candidate.acceptanceCriteria[metric].trim()) {
      fail(file, `acceptanceCriteria.${metric} is required`);
    }
  }
  if (!Number.isInteger(candidate.reproduction?.minimumSamplesPerCell)
      || candidate.reproduction.minimumSamplesPerCell < 1) {
    fail(file, 'reproduction.minimumSamplesPerCell must be a positive integer');
  }
  if (!Array.isArray(candidate.evidence)) fail(file, 'evidence must be an array');
}

console.log(`Validated ${files.length} network candidate${files.length === 1 ? '' : 's'}.`);
