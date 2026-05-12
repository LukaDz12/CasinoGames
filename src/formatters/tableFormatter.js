const { HEADERS } = require('./csvFormatter');

function pad(value, length) {
  const text = String(value ?? '');
  if (text.length >= length) {
    return text;
  }
  return text + ' '.repeat(length - text.length);
}

function formatTable(payload) {
  const rows = payload.rows || [];
  const widths = HEADERS.map((header) => header.length);

  for (const row of rows) {
    for (let i = 0; i < HEADERS.length; i += 1) {
      const value = String(row[HEADERS[i]] ?? '');
      widths[i] = Math.max(widths[i], value.length);
    }
  }

  const sep = widths.map((w) => '-'.repeat(w)).join('-+-');
  const headerLine = HEADERS.map((h, i) => pad(h, widths[i])).join(' | ');
  const rowLines = rows.map((row) => HEADERS.map((h, i) => pad(row[h], widths[i])).join(' | '));

  return [headerLine, sep, ...rowLines].join('\n');
}

module.exports = {
  formatTable
};
