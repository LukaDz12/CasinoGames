function escapeCsv(value) {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

function toCsv(headers, rows) {
  const headerLine = headers.map((h) => escapeCsv(h)).join(',');
  const lines = rows.map((row) => headers.map((h) => escapeCsv(row[h])).join(','));
  return [headerLine, ...lines].join('\n');
}

module.exports = {
  toCsv
};
