function validateIds(ids) {
  if (!Array.isArray(ids)) {
    throw new Error('ids must be an array');
  }

  const normalized = ids
    .map((id) => String(id || '').trim())
    .filter(Boolean);

  if (normalized.length === 0) {
    throw new Error('ids array is empty');
  }

  return normalized;
}

function validateFormat(format) {
  const value = String(format || 'json').trim().toLowerCase();
  const allowed = new Set(['json', 'csv', 'table']);

  if (!allowed.has(value)) {
    throw new Error('format must be one of: json, csv, table');
  }

  return value;
}

module.exports = {
  validateIds,
  validateFormat
};
