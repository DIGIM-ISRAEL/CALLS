// donation-analyzer.js
// ניתוח שיחות תרומה עם GPT-4

const https = require('https');
const fs = require('fs');
const { transcribeAudioWithWhisper } = require('./speech-analyzer');
const { saveDonationResults, setCallStatus } = require('./donation-airtable');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || (() => { try { return require('fs').readFileSync(require('path').join(__dirname, '.openai-key'), 'utf8').trim(); } catch { return ''; } })(); // env, else .openai-key next to this file — never commit the key
const GPT_MODEL = 'gpt-4o';

// קריאה ל-answer-checker (CDR+VAD) — המקור הסמכותי היחיד ל-call_status (Answered/No Answer).
// מחליף את ההסתמכות על שדה ה-AI call_answered שאינו אמין מספיק.
const ANSWER_CHECKER_URL = process.env.ANSWER_CHECKER_URL || 'http://127.0.0.1:3020/check-single';

// אם הלקוח נענה ויש לו פולואפ — מוחקים את 'Next Follow Up'
function clearFollowUp(recordId, airtableConfig) {
    return new Promise((resolve) => {
        const https = require('https');
        const body = JSON.stringify({ fields: { 'Next Follow Up': null } });
        const opts = {
            hostname: 'api.airtable.com', port: 443,
            path: `/v0/${airtableConfig.baseId}/${airtableConfig.tableId}/${recordId}`,
            method: 'PATCH',
            headers: { 'Authorization': `Bearer ${airtableConfig.apiKey}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
        };
        const req = https.request(opts, (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ ok: res.statusCode === 200, status: res.statusCode })); });
        req.on('error', e => resolve({ ok: false, error: e.message }));
        req.write(body); req.end();
    });
}

function runAnswerCheck(recordId, airtableConfig) {
    return new Promise((resolve) => {
        const http = require('http');
        const body = JSON.stringify({ recordId, airtableConfig, force: true });
        const req = http.request(ANSWER_CHECKER_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
            timeout: 180000
        }, (res) => {
            let data = '';
            res.on('data', d => data += d);
            res.on('end', () => {
                try {
                    const j = JSON.parse(data);
                    resolve({ ok: true, newStatus: j.newStatus, method: j.method, detail: j.detail, skipped: j.skipped, reason: j.reason });
                } catch (e) {
                    resolve({ ok: false, error: `parse: ${data.slice(0, 150)}` });
                }
            });
        });
        req.on('error', e => resolve({ ok: false, error: e.message }));
        req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
        req.write(body);
        req.end();
    });
}

async function analyzeDonationCall({ transcript, duration, fundraiserPhone, donorPhone }) {
    return new Promise((resolve) => {
        console.log(`\n🧠 === ANALYZING DONATION CALL ===`);
        console.log(`📝 Transcript length: ${transcript.length} chars`);

        const systemPrompt = `אתה מומחה ניתוח שיחות גיוס תרומות. נתח את השיחה הבאה והחזר JSON בלבד, ללא טקסט נוסף.`;

        const userPrompt = `נתח שיחת תרומה זו:

=== תמלול ===
${transcript}

=== פרטי שיחה ===
משך: ${duration || 'לא ידוע'} שניות
מתרים: ${fundraiserPhone || 'לא ידוע'}
תורם: ${donorPhone || 'לא ידוע'}

החזר JSON בפורמט הזה בלבד:
{
  "call_answered": <true אם הלקוח ענה ויש שיחה אמיתית, false אם לא ענה / תא קולי / שקט בלבד>,
  "donation_amount": <מספר בשקלים, 0 אם לא הוזכר>,
  "donation_type": <"חד פעמי" | "חודשי" | "שנתי" | "לא ידוע">,
  "decision": <"כן" | "לא" | "אולי">,
  "summary": <"סיכום קצר של השיחה בעברית, 2-3 משפטים">,
  "lead_quality": <מספר 1-5, איכות הליד - 5 הכי טוב>,
  "fundraiser_quality": <מספר 1-5, ביצועי המתרים - 5 הכי טוב>,
  "sentiment": <"positive" | "neutral_positive" | "neutral" | "neutral_negative" | "negative">,
  "improvement_suggestions": <"הצעות מפורטות לשיפור ביצועי הטלפן בעברית, כמה משפטים">,
  "sent_link": <true | false>
}

הנחיות:
- call_answered: false אם השיחה היא תא קולי, שקט, או שהסוכן דיבר לבד ללא מענה אנושי
- donation_amount: רק מספר (לא "500 ש"ח"), 0 אם לא הוזכר סכום
- decision: "כן" = הסכים לתרום, "לא" = סירב, "אולי" = לא החליט
- lead_quality: 5=מאוד מעוניין, 1=לא רלוונטי כלל
- fundraiser_quality: 5=מצוין, 1=גרוע
- sentiment: הלך הרוח הכללי של השיחה — positive=חיובי מאוד, neutral_positive=נוטה לחיובי, neutral=ניטרלי, neutral_negative=נוטה לשלילי, negative=שלילי/עוין
- improvement_suggestions: ניתוח ביקורתי וספציפי של ביצועי הטלפן — מה עבד טוב, מה אפשר לשפר, כיצד להתמודד עם ההתנגדויות שעלו
- sent_link: true רק אם הלקוח ביקש לקבל קישור/לינק/מידע בכתב
- החזר JSON תקין בלבד, ללא markdown`;

        const body = JSON.stringify({
            model: GPT_MODEL,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt }
            ],
            temperature: 0.3,
            max_tokens: 1000
        });

        const options = {
            hostname: 'api.openai.com',
            port: 443,
            path: '/v1/chat/completions',
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${OPENAI_API_KEY}`,
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body)
            }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    if (!parsed.choices || !parsed.choices[0]) {
                        return resolve({ success: false, error: 'No response from GPT' });
                    }

                    const rawContent = parsed.choices[0].message.content.trim();
                    console.log(`✅ GPT raw response: ${rawContent.substring(0, 100)}...`);

                    // נקה markdown backticks אם GPT החזיר ```json ... ```
                    const content = rawContent.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

                    const analysis = JSON.parse(content);

                    // וידוא ונרמול ערכים
                    const validTypes = ['חד פעמי', 'חודשי', 'שנתי', 'לא ידוע'];
                    const validDecisions = ['כן', 'לא', 'אולי'];
                    const validSentiments = ['positive', 'neutral_positive', 'neutral', 'neutral_negative', 'negative'];

                    resolve({
                        success: true,
                        analysis: {
                            donation_amount: parseFloat(analysis.donation_amount) || 0,
                            donation_type: validTypes.includes(analysis.donation_type) ? analysis.donation_type : 'לא ידוע',
                            decision: validDecisions.includes(analysis.decision) ? analysis.decision : 'אולי',
                            summary: String(analysis.summary || ''),
                            lead_quality: Math.min(5, Math.max(1, parseInt(analysis.lead_quality) || 3)),
                            fundraiser_quality: Math.min(5, Math.max(1, parseInt(analysis.fundraiser_quality) || 3)),
                            sentiment: validSentiments.includes(analysis.sentiment) ? analysis.sentiment : 'neutral',
                            improvement_suggestions: String(analysis.improvement_suggestions || ''),
                            sent_link: analysis.sent_link === true
                        }
                    });
                } catch (err) {
                    console.error(`❌ GPT parse error: ${err.message}`);
                    resolve({ success: false, error: `Parse error: ${err.message}` });
                }
            });
        });

        req.on('error', (err) => {
            console.error(`❌ GPT request error: ${err.message}`);
            resolve({ success: false, error: err.message });
        });

        req.write(body);
        req.end();
    });
}

module.exports = { analyzeDonationCall };

// ─── הפעלה כ-subprocess מ-recording-downloader.js ───────────
if (require.main === module) {
    console.log('📥 === DONATION ANALYZER STARTED ===');
    let inputData = '';

    process.stdin.on('data', chunk => { inputData += chunk.toString(); });

    process.stdin.on('end', async () => {
        if (!inputData.trim()) {
            console.log('📭 No stdin data');
            process.exit(1);
        }

        try {
            const jobData = JSON.parse(inputData);
            const { uuid, callInfo, airtableConfig, recordId, recording } = jobData;
            console.log(`📋 Processing donation analysis for UUID: ${uuid}`);

            // שלב 1: טעינת קובץ
            const audioFilePath = `/var/webhook-forwarder/recordings/${recording.filename}`;
            if (!fs.existsSync(audioFilePath)) {
                console.error(`❌ Audio file not found: ${audioFilePath}`);
                process.exit(1);
            }
            const audioBuffer = fs.readFileSync(audioFilePath);
            console.log(`✅ Loaded ${audioBuffer.length} bytes`);

            // שלב 2: תמלול
            console.log(`\n🎵 Transcribing...`);
            const transcriptionResult = await transcribeAudioWithWhisper(audioBuffer, recording.filename);
            if (!transcriptionResult.success) {
                console.error(`❌ Transcription failed: ${transcriptionResult.error}`);
                process.exit(1);
            }
            console.log(`✅ Transcript: ${transcriptionResult.transcript.length} chars`);

            // שלב 3: ניתוח GPT
            console.log(`\n🧠 Analyzing donation call...`);
            const analysisResult = await analyzeDonationCall({
                transcript: transcriptionResult.transcript,
                duration: callInfo?.call_duration,
                fundraiserPhone: callInfo?.cdr_ani,
                donorPhone: callInfo?.user_phone
            });
            if (!analysisResult.success) {
                console.error(`❌ Analysis failed: ${analysisResult.error}`);
                process.exit(1);
            }
            console.log(`✅ Analysis: decision=${analysisResult.analysis.decision}, amount=${analysisResult.analysis.donation_amount}`);

            // שלב 4: שמירה לאיירטייבל
            if (airtableConfig && recordId) {
                // שמירת תוצאות הניתוח (תמלול/סכום/החלטה) — תמיד, גם אם ה-AI חשב שלא נענה
                console.log(`\n📋 Saving analysis to Airtable...`);
                const saveResult = await saveDonationResults({
                    recordId,
                    transcript: transcriptionResult.transcript,
                    analysis: analysisResult.analysis,
                    airtableConfig
                });
                console.log(`📋 Save result: ${saveResult.success ? '✅ SUCCESS' : '❌ FAILED'}`);

                if (callInfo && callInfo.source === 'phone') {
                    // ערוץ הטלפון: אין CDR. call_status כבר נקבע מה-outcome של האפליקציה ב-/ingest-call.
                    // לא מריצים answer-checker (הוא מבוסס CDR+VAD של Maskyoo). הסטטוס נשאר כפי שנקבע.
                    console.log(`\n📞 Phone channel — trusting app-provided call_status (skipping CDR answer-checker).`);
                    const fu = await clearFollowUp(recordId, airtableConfig);
                    console.log(`📅 follow-up removed (phone answered): ${fu.ok ? 'OK' : 'FAILED ' + (fu.error || fu.status)}`);
                } else {
                    // call_status נקבע ע"י המתודה האמינה (CDR + VAD) — answer-checker הוא הסמכות, לא שדה ה-AI
                    console.log(`\n📞 Running answer-checker (CDR+VAD) for authoritative call_status...`);
                    const ac = await runAnswerCheck(recordId, airtableConfig);
                    if (ac.ok) {
                        console.log(`📞 answer-checker: ${ac.skipped ? `skipped (${ac.reason})` : `${ac.newStatus} [${ac.method}]`}`);
                    } else {
                        console.log(`📞 answer-checker FAILED: ${ac.error} — call_status left unchanged`);
                    }

                    // נענה → מורידים אותו מרשימת הפולואפים
                    if (ac.ok && ac.newStatus === 'Answered') {
                        const fu = await clearFollowUp(recordId, airtableConfig);
                        console.log(`📅 follow-up removed (answered): ${fu.ok ? 'OK' : 'FAILED ' + (fu.error || fu.status)}`);
                    }
                }
            }

            console.log('\n📤 === DONATION ANALYSIS COMPLETE ===');
            console.log(JSON.stringify({ success: true, uuid, recordId, analysis: analysisResult.analysis }));
            process.exit(0);

        } catch (err) {
            console.error(`❌ Fatal error: ${err.message}`);
            process.exit(1);
        }
    });
}
