const { toCsv } = require('../utils/csv');

const HEADERS = [
  'id',
  'source',
  'title',
  'layout',
  'betways',
  'buy_feature',
  'theme',
  'features',
  'url',
  'match_score'
];

function formatCsv(payload) {
  return toCsv(HEADERS, payload.rows || []);
}

module.exports = {
  formatCsv,
  HEADERS
};
