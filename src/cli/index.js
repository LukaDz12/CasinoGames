const { runSearch } = require('../core/engine');
const { formatJson } = require('../formatters/jsonFormatter');
const { formatCsv } = require('../formatters/csvFormatter');
const { formatTable } = require('../formatters/tableFormatter');

function getArgValue(flag, fallback = '') {
  const index = process.argv.indexOf(flag);
  if (index < 0 || index + 1 >= process.argv.length) {
    return fallback;
  }
  return process.argv[index + 1];
}

function parseIdsFromArgs() {
  const idsRaw = getArgValue('--ids', '');
  return idsRaw
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

function printResult(result) {
  if (result.format === 'csv') {
    process.stdout.write(`${formatCsv(result)}\n`);
    return;
  }

  if (result.format === 'table') {
    process.stdout.write(`${formatTable(result)}\n`);
    return;
  }

  process.stdout.write(`${formatJson(result)}\n`);
}

async function main() {
  try {
    const ids = parseIdsFromArgs();
    const format = getArgValue('--format', 'json');

    const result = await runSearch({ ids, format });
    printResult(result);
  } catch (error) {
    process.stderr.write(`Error: ${error.message}\n`);
    process.exitCode = 1;
  }
}

main();
