const mockSource = require('./sources/mockSource');
const slotcatalogSource = require('./sources/slotcatalogSource');
const slotstempleSource = require('./sources/slotstempleSource');
const livebetSource = require('./sources/livebetSource');
const passthroughService = require('./services/passthroughService');

const allSources = {
  mock: mockSource,
  slotcatalog: slotcatalogSource,
  slotstemple: slotstempleSource,
  livebet: livebetSource
};

function resolveSourcePlugins() {
  const configured = String(process.env.CASINO_SOURCES || 'slotcatalog,slotstemple,livebet')
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);

  const names = configured.length > 0 ? configured : ['slotcatalog', 'slotstemple', 'livebet'];
  const selected = names
    .map((name) => allSources[name])
    .filter(Boolean);

  return selected.length > 0 ? selected : [slotcatalogSource];
}

const sourcePlugins = resolveSourcePlugins();
const servicePlugins = [passthroughService];

module.exports = {
  sourcePlugins,
  servicePlugins
};
