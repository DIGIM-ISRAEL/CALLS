// donation-airtable.js
// עדכון Airtable לטבלת תרומות

const https = require('https');

async function updateDonationRecord(recordId, fields, airtableConfig) {
    return new Promise((resolve) => {
        console.log(`\n📋 === UPDATING DONATION AIRTABLE RECORD ===`);
        console.log(`🆔 Record: ${recordId}`);

        const body = JSON.stringify({ fields });

        const options = {
            hostname: 'api.airtable.com',
            port: 443,
            path: `/v0/${airtableConfig.baseId}/${airtableConfig.tableId}/${recordId}`,
            method: 'PATCH',
            headers: {
                'Authorization': `Bearer ${airtableConfig.apiKey}`,
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body)
            }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                if (res.statusCode === 200) {
                    console.log(`✅ Airtable updated successfully`);
                    resolve({ success: true });
                } else {
                    console.error(`❌ Airtable error ${res.statusCode}: ${data}`);
                    resolve({ success: false, error: `HTTP ${res.statusCode}: ${data}` });
                }
            });
        });

        req.on('error', (err) => {
            console.error(`❌ Airtable request error: ${err.message}`);
            resolve({ success: false, error: err.message });
        });

        req.write(body);
        req.end();
    });
}

// סטטוסי שיחה (נענה/לא נענה) — לא נדרסים על ידי תהליך הניתוח
const CALL_STATUSES = new Set(['Answered', 'No Answer', 'answered', 'no_answer']);

async function setCallStatus(recordId, status, airtableConfig) {
    if (CALL_STATUSES.has(status)) {
        // סטטוס שיחה — שדה call_status
        return updateDonationRecord(recordId, { call_status: status }, airtableConfig);
    } else {
        // סטטוס ניתוח (Processing / Done / Error) — שדה נפרד
        return updateDonationRecord(recordId, { analysis_status: status }, airtableConfig);
    }
}

// קריאת הרשומה — כדי לא לדרוס תרומה שכבר נרשמה ידנית/מאושרת
function getRecordFields(recordId, airtableConfig) {
    return new Promise((resolve) => {
        const req = https.request({
            hostname: 'api.airtable.com',
            port: 443,
            path: `/v0/${airtableConfig.baseId}/${airtableConfig.tableId}/${recordId}`,
            method: 'GET',
            headers: { 'Authorization': `Bearer ${airtableConfig.apiKey}` }
        }, (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                try { resolve(res.statusCode === 200 ? (JSON.parse(data).fields || {}) : null); }
                catch { resolve(null); }
            });
        });
        req.on('error', () => resolve(null));
        req.end();
    });
}

async function saveDonationResults({ recordId, transcript, analysis, airtableConfig }) {
    const fields = {
        call_transcript: transcript,
        donation_amount: analysis.donation_amount,
        donation_type: analysis.donation_type,
        decision: analysis.decision,
        summary: analysis.summary,
        lead_quality: analysis.lead_quality,
        fundraiser_quality: analysis.fundraiser_quality,
        Sentiment: analysis.sentiment,
        'Improvement Suggestions': analysis.improvement_suggestions,
        'sent link': analysis.sent_link,
        analysis_status: 'Done'   // לא דורס call_status (Answered/No Answer)
    };

    // סכום תרומה שזוהה ע"י ה-AI = תרומה משוערת → מסמנים את הצ'קבוקס 'maybe donation'
    if (Number(analysis.donation_amount) > 0) {
        fields['maybe donation'] = true;
    }

    // תרומה שכבר נרשמה (Donation Recorded At) היא מאושרת — הניתוח לא דורס סכום/סוג/החלטה
    // ולא מסמן 'maybe donation' (אחרת הקלטה שמגיעה אחרי ההזנה הידנית מאפסת את התרומה)
    const existing = await getRecordFields(recordId, airtableConfig);
    if (existing && existing['Donation Recorded At']) {
        console.log(`🔒 Donation already recorded (${existing['Donation Recorded At']}) — keeping amount/type/decision`);
        delete fields.donation_amount;
        delete fields.donation_type;
        delete fields.decision;
        delete fields['maybe donation'];
    }

    return updateDonationRecord(recordId, fields, airtableConfig);
}

module.exports = { setCallStatus, saveDonationResults };
