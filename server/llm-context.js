'use strict';

const fs = require('fs');
const path = require('path');
const pkg = require('../package.json');

const ROOT = path.join(__dirname, '..');
const REPOSITORY_URL = 'https://github.com/marguerite347/tari-diff-sim-multiplayer';
const SCHEMA_VERSION = 1;

// Only these public repository documents can reach the endpoint. Section
// selection keeps the bundle useful to an advisor without dumping the repo.
const ALLOWLIST = [
  {
    name: 'AGENTS.md',
    sections: ['What this project is', 'Architecture map', 'Simulation invariants — never break these'],
  },
  {
    name: '.cursor/rules/simulation-invariants.mdc',
    sections: ['Never break', 'Game-loop facts to respect', 'Research data (see also research-data rule)'],
  },
  {
    name: '.cursor/rules/research-data.mdc',
    sections: ['Schema rules', 'Objective types', 'Adding a challenge or variant'],
  },
  {
    name: 'skills/add-challenge/SKILL.md',
    sections: ['1. Write the factory', '2. Define bots and schedules', '3. Pick an objective'],
  },
  {
    name: 'skills/add-network-variant/SKILL.md',
    sections: ['1. Understand what a variant controls', '3. Understand the research cost'],
  },
  {
    name: 'skills/add-battlefield-visual/SKILL.md',
    sections: ['How the module is structured', 'The public API (event hooks from multiplayer.js)', 'Conventions'],
  },
  {
    name: 'skills/tune-copilot-strategy/SKILL.md',
    sections: ['Architecture', 'Narration conventions'],
  },
];

function extractSection(markdown, heading) {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => {
    const match = line.match(/^(#{1,6})\s+(.+?)\s*$/);
    return match && match[2] === heading;
  });
  if (start < 0) throw new Error(`Missing curated heading "${heading}"`);
  const level = lines[start].match(/^(#{1,6})/)[1].length;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    const match = lines[i].match(/^(#{1,6})\s+/);
    if (match && match[1].length <= level) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n').trim();
}

function commitIdentifier() {
  return process.env.RAILWAY_GIT_COMMIT_SHA
    || process.env.GIT_COMMIT_SHA
    || process.env.COMMIT_SHA
    || null;
}

function buildLlmContext(generatedAt = new Date().toISOString()) {
  const sources = ALLOWLIST.map(({ name, sections }) => {
    const markdown = fs.readFileSync(path.join(ROOT, name), 'utf8');
    return {
      name,
      sections: sections.map((heading) => ({
        heading,
        text: extractSection(markdown, heading),
      })),
    };
  });
  const commit = commitIdentifier();
  const buildId = commit || `${pkg.version}-${generatedAt}`;
  const characterCount = sources.reduce((sourceTotal, source) => sourceTotal
    + source.sections.reduce((sectionTotal, section) => sectionTotal + section.text.length, 0), 0);

  return {
    schemaVersion: SCHEMA_VERSION,
    repository: REPOSITORY_URL,
    version: {
      commit,
      packageVersion: pkg.version,
      buildId,
    },
    generatedAt,
    sources,
    characterCount,
  };
}

module.exports = { ALLOWLIST, buildLlmContext };
