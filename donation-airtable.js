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

async function setCallStatus(recordId, status, airtableConfig) {
    return updateDonationRecord(recordId, { call_status: status }, airtableConfig);
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
        call_status: 'Done'
    };

    return updateDonationRecord(recordId, fields, airtableConfig);
}

module.exports = { setCallStatus, saveDonationResults };
