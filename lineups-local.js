'use strict';
/* Curated projected line-ups (editorial), used only when API-Football has no
   confirmed line-up AND no previous real line-up to project from. Any API line-up
   always overrides this. Two sources, merged (override wins):
     - repo seed:  data/lineups.seed.json   (version-controlled defaults)
     - live file:  <data dir>/lineups.json   (editable on the persistent disk)
   Keyed by normalizeName(team) so "FC Barcelona" / "Barcelona" resolve to one entry. */
const fs = require('fs');
const path = require('path');
const { normalizeName } = require('./matching');

const SEED_FILE = path.join(__dirname, 'seed', 'lineups.json');                  // version-controlled (data/ is gitignored)
const OVERRIDE_FILE = process.env.LOCAL_LINEUPS_FILE
  || (process.env.HISTORY_FILE ? path.join(path.dirname(process.env.HISTORY_FILE), 'lineups.json') : path.join(__dirname, 'data', 'lineups.json'));

const POS = new Set(['GK', 'DF', 'MF', 'FW']);
let TEAMS = new Map();   // normKey -> { team, formation, xi, updated }

function sanitizePlayer(p) {
  if (!p || !p.name) return null;
  return {
    name: String(p.name).slice(0, 60),
    number: Number.isFinite(+p.number) ? +p.number : null,
    pos: POS.has(p.pos) ? p.pos : null,
    id: Number.isFinite(+p.id) ? +p.id : null,                                   // API-Football player id -> /portraits/{id}.png
    img: (typeof p.img === 'string' && /^[\w.-]{1,64}$/.test(p.img)) ? p.img : null, // bundled file -> /portraits-local/{img}
    grid: /^\d{1,2}:\d{1,2}$/.test(p.grid || '') ? p.grid : null
  };
}
function sanitizeEntry(name, e) {
  if (!e || !Array.isArray(e.xi)) return null;
  const xi = e.xi.map(sanitizePlayer).filter(Boolean);
  if (xi.length < 7) return null;                                                // need a credible XI, not a stub
  return {
    team: String(e.team || name).slice(0, 60),
    formation: /^\d(-\d){1,4}$/.test(e.formation || '') ? e.formation : null,
    xi: xi.slice(0, 11),
    updated: (typeof e.updated === 'string' && e.updated.slice(0, 10)) || null
  };
}
function loadFile(file) {
  try {
    if (!fs.existsSync(file)) return {};
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return (j && j.teams && typeof j.teams === 'object') ? j.teams : {};
  } catch (e) { console.error('lineups-local load error', file, e.message); return {}; }
}
function rebuild() {
  const merged = Object.assign({}, loadFile(SEED_FILE), loadFile(OVERRIDE_FILE));  // live file overrides seed
  const m = new Map();
  for (const [name, e] of Object.entries(merged)) {
    const key = normalizeName(name);
    const entry = sanitizeEntry(name, e);
    if (key && entry) m.set(key, entry);
  }
  TEAMS = m;
  return TEAMS.size;
}
rebuild();

// Curated projected XI for a team name -> matchinfo line-up shape, or null.
function projected(teamName) {
  const e = TEAMS.get(normalizeName(teamName || ''));
  if (!e) return null;
  return {
    formation: e.formation, coach: null, colors: null,
    xi: e.xi.map(p => ({ ...p })), subs: [],
    projectedFrom: { editorial: true, date: e.updated || null }
  };
}

module.exports = { projected, rebuild, size: () => TEAMS.size, overrideFile: OVERRIDE_FILE };
