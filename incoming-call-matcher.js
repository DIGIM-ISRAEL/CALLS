// incoming-call-matcher.js
// סורק שיחות נכנסות מאתמול ומעבד אותן דרך הפייפליין הקיים
// רץ אוטומטית כל יום ב-02:00 שעון ישראל

const https = require('https');
const { spawn } = require('child_process');
const cron = require('node-cron');

// ═══════════════════════════════════════════
// קונפיגורציה
// ═══════════════════════════════════════════

const MASKYOO_CONFIG = {
    apiKey: 'process.env.MASKYOO_API_KEY',
    baseUrl: 'https://app.maskyoo.co.il/issa_153/api/'
};

const AIRTABLE_API_KEY = 'process.env.AIRTABLE_API_KEY';
const AIRTABLE_BASE_ID = 'app5pnaEc4UK3RUcP';

// ═══════════════════════════════════════════
// הוספת טבלה חדשה – רק כאן, שום דבר אחר לא משתנה
// ═══════════════════════════════════════════
const TABLES = [
    {
        tableId: 'tblABFOvI4cQSz3sg',
        tableName: 'Gem diamura',
        phoneField: 'phone_number',
        virtualNumberField: 'phone_my_user'
    },
    {
        tableId: 'tblcNkAMMCJQ3EVMl',
        tableName: 'leads of Clients: Telemarketing',
        phoneField: 'phone_number',
        virtualNumberField: 'phone_my_user'
    }
    // להוספת טבלה חדשה: העתק בלוק אחד למעלה ושנה tableId ו-tableName בלבד
];

// ═══════════════════════════════════════════
// פונקציות עזר
// ═══════════════════════════════════════════

function formatPhoneNumber(phone) {
    const cleaned = String(phone).replace(/\D/g, '');
    if (cleaned.startsWith('972')) return cleaned;
    if (cleaned.startsWith('0')) return '972' + cleaned.substring(1);
    return '972' + cleaned;
}

function formatDateSQL(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + day + ' 00:00:00';
}

// ═══════════════════════════════════════════
// שלב 1 – שליפת מספרים וירטואליים מכל הטבלאות
// ═══════════════════════════════════════════

async function fetchVirtualNumbersFromTable(table) {
    const virtualNumbers = new Set();
    let offset = null;

    do {
        let path = '/v0/' + AIRTABLE_BASE_ID + '/' + table.tableId +
            '?fields[]=' + encodeURIComponent(table.virtualNumberField) + '&pageSize=100';
        if (offset) path += '&offset=' + encodeURIComponent(offset);

        const result = await new Promise((resolve, reject) => {
            const options = {
                hostname: 'api.airtable.com',
                port: 443,
                path: path,
                method: 'GET',
                headers: {
                    'Authorization': 'Bearer ' + AIRTABLE_API_KEY,
                    'Content-Type': 'application/json'
                }
            };

            const req = https.request(options, (res) => {
                let data = '';
                res.on('data', chunk => { data += chunk; });
                res.on('end', () => {
                    try {
                        const json = JSON.parse(data);
                        if (res.statusCode !== 200) {
                            reject(new Error('Airtable error (' + res.statusCode + ') table ' + table.tableName + ': ' + data));
                        } else {
                            resolve(json);
                        }
                    } catch (e) {
                        reject(new Error('Invalid JSON from Airtable: ' + data));
                    }
                });
            });
            req.on('error', reject);
            req.end();
        });

        for (const record of result.records || []) {
            const phone = record.fields[table.virtualNumberField];
            if (phone) virtualNumbers.add(formatPhoneNumber(String(phone).trim()));
        }
        offset = result.offset || null;

    } while (offset);

    return virtualNumbers;
}

async function fetchAllVirtualNumbers() {
    console.log('\n=== STEP 1: FETCHING VIRTUAL NUMBERS FROM ALL TABLES ===');
    const combined = new Set();

    for (const table of TABLES) {
        try {
            const nums = await fetchVirtualNumbersFromTable(table);
            console.log('  [' + table.tableName + '] ' + nums.size + ' virtual numbers');
            for (const n of nums) combined.add(n);
        } catch (err) {
            console.error('  ERROR fetching from ' + table.tableName + ': ' + err.message);
        }
    }

    console.log('Total unique virtual numbers: ' + combined.size);
    return combined;
}

// ═══════════════════════════════════════════
// שלב 2 – שליפת שיחות נכנסות ממסקיו
// ═══════════════════════════════════════════

async function fetchIncomingCalls(virtualNumbers, targetDate) {
    console.log('\n=== STEP 2: FETCHING INCOMING CALLS FROM MASKYOO ===');

    let startDate, endDate;

    if (targetDate) {
        startDate = new Date(targetDate + 'T00:00:00');
        endDate = new Date(targetDate + 'T00:00:00');
        endDate.setDate(endDate.getDate() + 1);
    } else {
        // אתמול בזמן ישראלי – DST-aware
        const israeliNow = new Date(
            new Date().toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' })
        );
        endDate = new Date(israeliNow);
        endDate.setHours(0, 0, 0, 0);
        startDate = new Date(endDate);
        startDate.setDate(startDate.getDate() - 1);
    }

    const startStr = formatDateSQL(startDate);
    const endStr = formatDateSQL(endDate);

    if (virtualNumbers.size === 0) {
        console.log('No virtual numbers to filter by - aborting');
        return [];
    }

    const numbersInList = Array.from(virtualNumbers).map(n => "'" + n + "'").join(', ');

    const sqlQuery =
        "SELECT cdr_uniqueid, start_call, end_call, call_duration, cdr_ani, cdr_ddi, user_phone, call_status " +
        "FROM webserviceview " +
        "WHERE start_call >= '" + startStr + "' " +
        "AND start_call < '" + endStr + "' " +
        "AND call_status = 'ANSWERED' " +
        "AND call_duration > 20 " +
        "AND cdr_ddi IN (" + numbersInList + ") " +
        "ORDER BY start_call ASC";

    console.log('Date range: ' + startStr + ' → ' + endStr);
    console.log('Filtering by ' + virtualNumbers.size + ' virtual numbers');

    const result = await new Promise((resolve, reject) => {
        const params = new URLSearchParams({ service: 'cdr_query', sql: sqlQuery, format: 'json' });
        const url = MASKYOO_CONFIG.baseUrl + '?' + params.toString();

        const options = {
            method: 'GET',
            headers: {
                'Authorization': 'Bearer ' + MASKYOO_CONFIG.apiKey,
                'User-Agent': 'IncomingCallMatcher/2.0'
            }
        };

        const req = https.request(url, options, (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                try { resolve(JSON.parse(data)); }
                catch (e) { reject(new Error('Invalid JSON from Maskyoo: ' + data)); }
            });
        });
        req.on('error', reject);
        req.end();
    });

    if (result.status && result.status.code === 200) {
        const calls = result.result || [];
        console.log('Found ' + calls.length + ' incoming calls');
        return calls;
    } else {
        console.log('No calls found or API issue: ' + JSON.stringify(result.status));
        return [];
    }
}

// ═══════════════════════════════════════════
// שלב 3 – התאמה לרקורדים בכל הטבלאות
// ═══════════════════════════════════════════

async function findMatchingRecordsInTable(callerPhone, table) {
    const formatted = formatPhoneNumber(callerPhone);
    const localFormat = formatted.startsWith('972') ? '0' + formatted.substring(3) : formatted;

    const formula = encodeURIComponent(
        "OR({" + table.phoneField + "} = '" + formatted + "', " +
        "{" + table.phoneField + "} = '" + localFormat + "')"
    );

    const result = await new Promise((resolve, reject) => {
        const options = {
            hostname: 'api.airtable.com',
            port: 443,
            path: '/v0/' + AIRTABLE_BASE_ID + '/' + table.tableId + '?filterByFormula=' + formula,
            method: 'GET',
            headers: {
                'Authorization': 'Bearer ' + AIRTABLE_API_KEY,
                'Content-Type': 'application/json'
            }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (res.statusCode === 200) { resolve(json); }
                    else { reject(new Error('Airtable search error (' + res.statusCode + ') in ' + table.tableName + ': ' + data)); }
                } catch (e) { reject(new Error('Invalid JSON from Airtable: ' + data)); }
            });
        });
        req.on('error', reject);
        req.end();
    });

    return (result.records || []).map(record => ({ record, table }));
}

async function findAllMatchingRecords(callerPhone) {
    const allMatches = [];

    for (const table of TABLES) {
        try {
            const matches = await findMatchingRecordsInTable(callerPhone, table);
            allMatches.push(...matches);
        } catch (err) {
            console.error('  ERROR searching in ' + table.tableName + ': ' + err.message);
        }
    }

    return allMatches;
}

// ═══════════════════════════════════════════
// שלב 4 – עיבוד שיחה דרך uuid-tester.js
// ═══════════════════════════════════════════

async function processCallWithUUIDTester(call, record, table) {
    const jobData = {
        recordId: record.id,
        phoneMyUser: formatPhoneNumber(call.cdr_ddi),
        phoneNumber: formatPhoneNumber(call.cdr_ani),
        callTime: call.start_call,
        uuid: call.cdr_uniqueid,
        callInfo: {
            cdr_uniqueid: call.cdr_uniqueid,
            start_call: call.start_call,
            end_call: call.end_call,
            call_duration: call.call_duration,
            cdr_ani: call.cdr_ani,
            cdr_ddi: call.cdr_ddi,
            user_phone: call.user_phone,
            call_status: call.call_status
        },
        skipDelay: true,
        airtableConfig: {
            apiKey: AIRTABLE_API_KEY,
            baseId: AIRTABLE_BASE_ID,
            tableId: table.tableId,
            tableName: table.tableName,
            uuidField: 'UUID',
            callStatusField: 'Last Call Status',
            callTimeField: 'Last Call Time',
            callIdField: 'id_caller'
        }
    };

    console.log('    Spawning uuid-tester.js: UUID=' + call.cdr_uniqueid + ' Record=' + record.id + ' Table=' + table.tableName);

    return new Promise((resolve) => {
        const child = spawn('node', ['uuid-tester.js'], {
            cwd: '/var/webhook-forwarder',
            stdio: ['pipe', 'pipe', 'pipe']
        });

        let output = '';
        let errors = '';

        child.stdout.on('data', data => {
            const line = data.toString().trim();
            output += line + '\n';
            console.log('      > ' + line);
        });

        child.stderr.on('data', data => {
            const line = data.toString().trim();
            errors += line + '\n';
            console.error('      ERR> ' + line);
        });

        child.on('close', code => {
            console.log('    uuid-tester.js exited: ' + code);
            resolve({ success: code === 0, code, output, errors, uuid: call.cdr_uniqueid, recordId: record.id });
        });

        child.on('error', err => {
            console.error('    Spawn error: ' + err.message);
            resolve({ success: false, error: err.message, uuid: call.cdr_uniqueid, recordId: record.id });
        });

        // race condition protection – זהה לגישה ב-uuid-tester.js
        setTimeout(() => {
            try {
                child.stdin.write(JSON.stringify(jobData));
                child.stdin.end();
            } catch (err) {
                console.error('    stdin write error: ' + err.message);
            }
        }, 100);
    });
}

// ═══════════════════════════════════════════
// ריצה ראשית
// ═══════════════════════════════════════════

async function runIncomingCallMatcher(options) {
    options = options || {};
    const dryRun = options.dryRun || false;
    const targetDate = options.targetDate || null;

    const stats = {
        tablesScanned: TABLES.length,
        totalCalls: 0,
        matched: 0,
        processed: 0,
        alreadyProcessed: 0,
        notFound: 0,
        errors: 0
    };

    const runStart = new Date();
    console.log('\n' + '═'.repeat(47));
    console.log('  INCOMING CALL MATCHER STARTED');
    console.log('  ' + runStart.toISOString());
    if (dryRun) console.log('  *** DRY RUN MODE – no actual processing ***');
    if (targetDate) console.log('  Target date: ' + targetDate);
    console.log('═'.repeat(47));

    try {
        // שלב 1
        const virtualNumbers = await fetchAllVirtualNumbers();

        if (virtualNumbers.size === 0) {
            console.log('No virtual numbers found – aborting');
            printSummary(stats, runStart);
            return;
        }

        // שלב 2
        const calls = await fetchIncomingCalls(virtualNumbers, targetDate);
        stats.totalCalls = calls.length;

        if (calls.length === 0) {
            console.log('No incoming calls found for this date');
            printSummary(stats, runStart);
            return;
        }

        console.log('\n=== STEP 3+4: MATCHING AND PROCESSING ===');
        console.log('Processing ' + calls.length + ' calls sequentially...\n');

        // שלב 3+4 – sequential
        for (const call of calls) {
            try {
                console.log('Call: ' + call.cdr_ani + ' → ' + call.cdr_ddi +
                    ' | ' + call.start_call + ' | ' + call.call_duration + 's | UUID: ' + call.cdr_uniqueid);

                // שלב 3 – חיפוש בכל הטבלאות
                const matches = await findAllMatchingRecords(call.cdr_ani);

                if (matches.length === 0) {
                    console.log('  No matching record for ' + call.cdr_ani + ' – skipping');
                    stats.notFound++;
                    continue;
                }

                stats.matched++;
                const matchDesc = matches.map(m => m.table.tableName + ':' + m.record.id).join(', ');
                console.log('  Found ' + matches.length + ' record(s): ' + matchDesc);

                if (dryRun) {
                    console.log('  DRY RUN: would process ' + matches.length + ' record(s)');
                    stats.processed += matches.length;
                    continue;
                }

                // שלב 4 – עיבוד sequential
                for (const { record, table } of matches) {
                    try {
                        const result = await processCallWithUUIDTester(call, record, table);
                        if (result.success) {
                            console.log('  ✓ OK: ' + table.tableName + ':' + record.id);
                            stats.processed++;
                        } else {
                            console.error('  ✗ FAIL: ' + table.tableName + ':' + record.id + ' (code ' + result.code + ')');
                            stats.errors++;
                        }
                    } catch (err) {
                        console.error('  ERROR ' + table.tableName + ':' + record.id + ': ' + err.message);
                        stats.errors++;
                    }
                }

            } catch (err) {
                console.error('ERROR processing call ' + call.cdr_uniqueid + ': ' + err.message);
                stats.errors++;
            }
        }

    } catch (error) {
        console.error('\nFATAL ERROR: ' + error.message);
        stats.errors++;
    }

    printSummary(stats, runStart);
}

function printSummary(stats, runStart) {
    const now = new Date();
    const timeStr = now.toTimeString().split(' ')[0]; // HH:MM:SS

    console.log('\n' + '═'.repeat(35));
    console.log(' ריצה הסתיימה – ' + timeStr);
    console.log('');
    console.log(' טבלאות שנסרקו:     ' + stats.tablesScanned);
    console.log(' שיחות נכנסות:      ' + stats.totalCalls);
    console.log(' הותאמו לרקורד:     ' + stats.matched);
    console.log(' עובדו בהצלחה:      ' + stats.processed);
    console.log(' כבר עובדו:         ' + stats.alreadyProcessed);
    console.log(' לא נמצא רקורד:     ' + stats.notFound);
    console.log(' שגיאות:            ' + stats.errors);
    console.log('═'.repeat(35) + '\n');
}

// ═══════════════════════════════════════════
// Cron Job – כל יום ב-02:00 שעון ישראל
// ═══════════════════════════════════════════

cron.schedule('0 2 * * *', () => {
    console.log('\nCron triggered – running incoming call matcher...');
    runIncomingCallMatcher().catch(err => {
        console.error('Cron job failed: ' + err.message);
    });
}, { timezone: 'Asia/Jerusalem' });

console.log('Incoming call matcher loaded – cron scheduled 02:00 Asia/Jerusalem');

// ═══════════════════════════════════════════
// CLI – הרצה ידנית
// ═══════════════════════════════════════════

if (require.main === module) {
    const args = process.argv.slice(2);
    const dryRun = args.includes('--dry-run');
    let targetDate = null;
    const dateIdx = args.indexOf('--date');
    if (dateIdx !== -1 && args[dateIdx + 1]) {
        targetDate = args[dateIdx + 1];
    }

    runIncomingCallMatcher({ dryRun, targetDate }).catch(err => {
        console.error('Fatal: ' + err.message);
        process.exit(1);
    });
}
