'use strict';

(function (root, factory) {
  const callsigns = factory();
  if (typeof module === 'object' && module.exports) module.exports = callsigns;
  else root.Callsigns = callsigns;
})(typeof globalThis !== 'undefined' ? globalThis : window, function () {
  const ADJECTIVES = [
    'SOLAR', 'DEEP', 'BRIGHT', 'SWIFT', 'IRON', 'LUNAR', 'NOVA', 'PRIME',
    'VIVID', 'RAPID', 'STEADY', 'BOLD', 'QUIET', 'ARCTIC', 'COSMIC', 'AMBER',
  ];
  const ROLES = [
    'SENTRY', 'RELAY', 'SCOUT', 'PILOT', 'WARDEN', 'RANGER', 'BEACON', 'FORGE',
    'GUARD', 'TRACKER', 'SIGNAL', 'VOYAGER',
  ];
  const MAX_LENGTH = 24;

  function format(adjective, role, number) {
    return `MINER-${adjective}-${role}-${String(number).padStart(3, '0')}`;
  }

  function generate(randomInt) {
    const adjective = ADJECTIVES[randomInt(ADJECTIVES.length)];
    const role = ROLES[randomInt(ROLES.length)];
    return format(adjective, role, randomInt(1000));
  }

  return Object.freeze({
    ADJECTIVES: Object.freeze(ADJECTIVES),
    ROLES: Object.freeze(ROLES),
    MAX_LENGTH,
    format,
    generate,
  });
});
