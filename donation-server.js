// donation-server.js
// שרת עיבוד שיחות תרומה — PORT 3002
// זרימה: חייג → המתן לסיום → UUID מה-CDR → הורד → תמלל → נתח → שמור

const express = require('express');
const crypto = require('crypto');
const https = require('https');

const { processRecordingDownload } = require('./recording-downloader');
const { setCallStatus } = require('./donation-airtable');

const app = express();
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, x-secret-key');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});
app.use(express.json());

const PORT = process.env.PORT || 3002;
const SECRET_KEY = process.env.DONATION_SECRET_KEY || 'mK9vR3pQ8nX2fA7sB1cD4eF6gH5jL0mN';

const MASKYOO_CONFIG = {
    apiKey: 'process.env.MASKYOO_API_KEY'
};

const activeJobs = new Map();

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function formatPhone(phone) {
    let cleaned = String(phone).replace(/\D/g, '');
    if (cleaned.startsWith('0')) cleaned = '972' + cleaned.substring(1);
    if (!cleaned.startsWith('972')) cleaned = '972' + cleaned;
    // Fix: remove extra 0 after country code (e.g., 9720525... → 972525...)
    if (cleaned.startsWith('9720')) cleaned = '972' + cleaned.substring(4);
    return cleaned;
}

// ─── אבטחה ───────────────────────────────────────────────
function verifySecretKey(req, res, next) {
    if (req.headers['x-secret-key'] !== SECRET_KEY) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    next();
}

// ─── שלב 1: חיוג למסקיו ──────────────────────────────────
async function dialCall(phoneNumber, phoneMyUser) {
    return new Promise((resolve) => {
        const params = new URLSearchParams({
            service: 'create_maskyoo_call_v2',
            maskyoo1: phoneMyUser,
            destination1: phoneMyUser,
            destination2: phoneNumber,
            format: 'json'
        });

        const url = `https://app.maskyoo.co.il/issa_153/api/?${params.toString()}`;
        const options = {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${MASKYOO_CONFIG.apiKey}`,
                'User-Agent': 'Webhook-Forwarder-Fixed/3.7'
            }
        };

        const req = https.request(url, options, (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                console.log(`📨 Maskyoo raw response: ${data}`);
                try {
                    const parsed = JSON.parse(data);
                    if (parsed.status?.code === 200) {
                        resolve({ success: true, callId: parsed.result?.call_id });
                    } else {
                        resolve({ success: false, error: parsed.status?.description || 'Maskyoo error' });
                    }
                } catch (e) {
                    resolve({ success: false, error: `${e.message} | raw: ${data.substring(0, 100)}` });
                }
            });
        });
        req.on('error', e => resolve({ success: false, error: e.message }));
        req.end();
    });
}

// ─── שלב 2: המתנה לסיום שיחה + UUID מה-CDR ───────────────
async function waitForCallAndGetUUID(phoneMyUser, phoneNumber, phoneFundraiser, callStartTime, timeoutMinutes = 15) {
    const maxAttempts = (timeoutMinutes * 60) / 10;

    // CDR מאחסן UTC — אין צורך בהמרת timezone
    const startDate = new Date(callStartTime - 2 * 60 * 1000); // 2 דקות אחורה לבטיחות
    const startStr = startDate.toISOString().replace('T', ' ').substring(0, 19);

    for (let i = 0; i < maxAttempts; i++) {
        await sleep(10000);

        const sql = `SELECT cdr_uniqueid, end_call, call_duration, call_status ` +
                    `FROM webserviceview ` +
                    `WHERE cdr_ddi = '${phoneMyUser}' ` +
                    `AND (cdr_ani = '${phoneNumber}' OR user_phone = '${phoneNumber}') ` +
                    `AND start_call >= '${startStr}' ` +
                    `AND end_call IS NOT NULL ` +
                    `ORDER BY start_call DESC LIMIT 1`;

        const result = await queryCDR(sql);

        if (result.length > 0 && result[0].end_call) {
            return {
                found: true,
                uuid: result[0].cdr_uniqueid,
                duration: result[0].call_duration,
                status: result[0].call_status,
                endCall: result[0].end_call
            };
        }

        console.log(`⏳ Attempt ${i + 1}/${maxAttempts} — call not ended yet`);
    }

    return { found: false, reason: 'timeout' };
}

async function queryCDR(sql) {
    return new Promise((resolve) => {
        const postData = new URLSearchParams({
            service: 'cdr_query',
            sql,
            format: 'json'
        }).toString();

        const options = {
            hostname: 'app.maskyoo.co.il',
            port: 443,
            path: '/issa_153/api/',
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${MASKYOO_CONFIG.apiKey}`,
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(postData)
            }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                try { resolve(JSON.parse(data).result || []); }
                catch (e) { resolve([]); }
            });
        });
        req.on('error', () => resolve([]));
        req.write(postData);
        req.end();
    });
}

// ─── זרימה מרכזית ─────────────────────────────────────────
async function processDonation({ jobId, recordId, phoneNumber, phoneMyUser, phoneFundraiser, airtableConfig }) {
    const startTime = Date.now();
    console.log(`\n🎯 === STARTING DONATION JOB: ${jobId} ===`);
    console.log(`📞 maskyoo1=${phoneMyUser} destination1=${phoneFundraiser || phoneMyUser} → ${phoneNumber} | Record: ${recordId}`);

    const updateJob = (status, progress) =>
        activeJobs.set(jobId, { status, progress, recordId, startTime });

    await setCallStatus(recordId, 'Processing', airtableConfig);
    updateJob('dialing', 10);

    // שלב 1: חיוג
    console.log(`\n📞 === STEP 1: DIALING ===`);
    const dialResult = await dialCall(phoneNumber, phoneMyUser);
    console.log(`📞 Dial result:`, JSON.stringify(dialResult));
    if (!dialResult.success) {
        console.error(`❌ Dial failed: ${dialResult.error}`);
        await setCallStatus(recordId, 'Error', airtableConfig);
        activeJobs.delete(jobId);
        return { success: false, step: 'dial', error: dialResult.error };
    }
    console.log(`✅ Call sent`);
    updateJob('waiting', 20);

    // שלב 2: המתנה לסיום + UUID
    console.log(`\n⏳ === STEP 2: WAITING FOR CALL TO END ===`);
    const callStartTime = Date.now();
    const cdrResult = await waitForCallAndGetUUID(phoneMyUser, phoneNumber, null, callStartTime);

    if (!cdrResult.found) {
        await setCallStatus(recordId, 'Error', airtableConfig);
        activeJobs.delete(jobId);
        return { success: false, step: 'cdr', error: 'Call not found in CDR (timeout)' };
    }

    const uuid = cdrResult.uuid;
    console.log(`✅ Call ended — UUID: ${uuid} | Duration: ${cdrResult.duration}s`);
    updateJob('downloading', 40);

    // שלבים 3-6: הורדה + העלאה לאיירטייבל + Pabbly + ניתוח תרומה
    console.log(`\n📥 === STEP 3: FULL RECORDING PROCESS ===`);
    const processResult = await processRecordingDownload({
        uuid,
        callInfo: {
            cdr_uniqueid: uuid,
            end_call: cdrResult.endCall,
            call_duration: cdrResult.duration,
            call_status: cdrResult.status,
            cdr_ani: phoneMyUser,
            user_phone: phoneNumber
        },
        airtableConfig,
        recordId,
        jobId,
        analyzerScript: 'donation-analyzer.js'
    });

    activeJobs.delete(jobId);
    const processingTime = Math.round((Date.now() - startTime) / 1000);
    console.log(`\n✅ === JOB DONE: ${jobId} (${processingTime}s) ===`);

    return {
        success: processResult.success,
        recordId,
        uuid,
        processing_time_seconds: processingTime,
        recording: processResult.recording
    };
}

// ─── Endpoints ────────────────────────────────────────────

app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        service: 'donation-processor',
        version: '2.0.0',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        activeJobs: activeJobs.size
    });
});

app.get('/status/:jobId', (req, res) => {
    const job = activeJobs.get(req.params.jobId);
    if (!job) return res.status(404).json({ success: false, error: 'Job not found' });
    res.json({
        jobId: req.params.jobId,
        status: job.status,
        progress: job.progress,
        recordId: job.recordId,
        elapsedSeconds: Math.round((Date.now() - job.startTime) / 1000)
    });
});

app.post('/process-donation', verifySecretKey, async (req, res) => {
    console.log(`\n📥 === NEW DONATION REQUEST ===`);
    console.log(`⏰ ${new Date().toISOString()}`);
    console.log(`📋 Body:`, JSON.stringify(req.body, null, 2));

    const { recordId, phoneNumber, phoneMyUser, phoneFundraiser, airtableConfig } = req.body;

    if (!recordId || !phoneNumber || !phoneMyUser || !airtableConfig?.apiKey || !airtableConfig?.baseId || !airtableConfig?.tableId) {
        return res.status(400).json({
            success: false,
            error: 'Missing required fields: recordId, phoneNumber, phoneMyUser, airtableConfig (apiKey, baseId, tableId)'
        });
    }

    const formattedPhone = formatPhone(phoneNumber);
    const formattedPhoneMyUser = formatPhone(phoneMyUser);
    const formattedPhoneFundraiser = phoneFundraiser ? formatPhone(phoneFundraiser) : null;

    const jobId = `don_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    activeJobs.set(jobId, { status: 'starting', progress: 0, recordId, startTime: Date.now() });

    // תשובה מיידית ל-Lovable — עיבוד ברקע
    res.json({
        success: true,
        message: 'Processing started',
        jobId,
        statusUrl: `https://retrieval-nearest-geographical-banners.trycloudflare.com/status/${jobId}`
    });

    // עיבוד ברקע
    processDonation({
        jobId,
        recordId,
        phoneNumber: formattedPhone,
        phoneMyUser: formattedPhoneMyUser,
        phoneFundraiser: formattedPhoneFundraiser,
        airtableConfig
    }).catch(err => console.error(`❌ Job ${jobId} failed:`, err.message));
});

// ─── הפעלה ───────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n💚 === DONATION PROCESSOR v2.0 ===`);
    console.log(`📍 Port: ${PORT}`);
    console.log(`📮 Process: POST /process-donation`);
    console.log(`⏰ Started: ${new Date().toISOString()}\n`);
});

process.on('SIGTERM', () => {
    console.log('⏹️ Shutting down gracefully...');
    process.exit(0);
});
