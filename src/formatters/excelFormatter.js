const ExcelJS = require('exceljs');

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

async function formatExcel(payload) {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet('Results', {
    views: [{ state: 'frozen', ySplit: 1 }]
  });

  worksheet.columns = [
    { header: 'id', key: 'id', width: 28 },
    { header: 'source', key: 'source', width: 14 },
    { header: 'title', key: 'title', width: 44 },
    { header: 'layout', key: 'layout', width: 10 },
    { header: 'betways', key: 'betways', width: 10 },
    { header: 'buy_feature', key: 'buy_feature', width: 12 },
    { header: 'theme', key: 'theme', width: 36 },
    { header: 'features', key: 'features', width: 56 },
    { header: 'url', key: 'url', width: 52 },
    { header: 'match_score', key: 'match_score', width: 12 }
  ];

  const rows = payload.rows || [];
  for (const row of rows) {
    worksheet.addRow(row);
  }

  worksheet.autoFilter = {
    from: 'A1',
    to: 'J1'
  };

  const header = worksheet.getRow(1);
  header.height = 22;
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.alignment = { vertical: 'middle', horizontal: 'center' };
  header.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FF2F5597' }
  };

  const groupPalette = ['FFF2F8FF', 'FFFFF9F0', 'FFF4FFF1', 'FFFFF1F7', 'FFF4F4F4'];
  const sourceFontColor = {
    'slotcatalog': 'FF1F4E78',
    'slotstemple': 'FF0B6E4F',
    'livebet': 'FF663399',
    'slotcatalog|slotstemple': 'FF1F4E78',
    'slotcatalog|livebet': 'FF663399',
    'slotstemple|livebet': 'FF0B6E4F'
  };
  const gameColorMap = new Map();
  let gameColorIndex = 0;

  for (let i = 2; i <= worksheet.rowCount; i += 1) {
    const row = worksheet.getRow(i);
    const rowModel = rows[i - 2];

    const gameKey = rowModel.id || `__blank_${i}`;
    if (!gameColorMap.has(gameKey)) {
      gameColorMap.set(gameKey, groupPalette[gameColorIndex % groupPalette.length]);
      gameColorIndex += 1;
    }

    const rowColor = gameColorMap.get(gameKey);
    for (let c = 1; c <= worksheet.columnCount; c += 1) {
      const cell = row.getCell(c);
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: rowColor }
      };
      cell.alignment = { vertical: 'top', wrapText: c >= 7 };
    }

    const sourceCell = row.getCell(2);
    const sourceKey = String(rowModel.source || '').toLowerCase();
    if (sourceFontColor[sourceKey]) {
      sourceCell.font = { bold: true, color: { argb: sourceFontColor[sourceKey] } };
    }
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return buffer;
}

module.exports = {
  formatExcel,
  HEADERS
};
