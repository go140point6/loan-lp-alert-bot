const fs = require('fs');
const { parse } = require('csv-parse/sync');

/**
 * Reads CSV file and returns an array of row objects.
 */
function readCsvRows(csvPath) {
  if (!fs.existsSync(csvPath)) {
    console.warn(`[WARN] CSV file not found: ${csvPath}`);
    return [];
  }

  const content = fs.readFileSync(csvPath, 'utf8');
  if (!content.trim()) {
    return [];
  }

  const records = parse(content, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  });

  return records;
}

module.exports = {
  readCsvRows,
};