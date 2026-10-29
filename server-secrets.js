// סודות השרת — env קודם, אחרת קובץ root-only בתיקיית השרת. לעולם לא בקוד ולא בלוג.
// .airtable-key / .maskyoo-key / .donation-key / .app-key / .openai-key (כולם ב-.gitignore)
const fs = require('fs');
const path = require('path');

function readSecret(envName, fileName) {
    if (process.env[envName]) return process.env[envName].trim();
    try { return fs.readFileSync(path.join(__dirname, fileName), 'utf8').trim(); } catch (_) { return ''; }
}

// הגדרות איירטייבל בצד השרת — הדפדפן כבר לא שולח טוקן
function airtableConfig() {
    return {
        apiKey: readSecret('AIRTABLE_API_KEY', '.airtable-key'),
        baseId: 'app5pnaEc4UK3RUcP', tableId: 'tblcNkAMMCJQ3EVMl',
        uuidField: 'UUID', callStatusField: 'call_status', callTimeField: 'call_time', callIdField: 'id_caller',
    };
}

module.exports = { readSecret, airtableConfig };
