// donation-analyzer.js
// ניתוח שיחות תרומה עם GPT-4

const https = require('https');
const fs = require('fs');
const { transcribeAudioWithWhisper } = require('./speech-analyzer');
const { saveDonationResults, setCallStatus } = require('./donation-airtable');

const OPENAI_API_KEY = 'process.env.OPENAI_API_KEY';
const GPT_MODEL = 'gpt-4o';

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
                if (analysisResult.analysis.call_answered === false) {
                    console.log(`📵 AI detected call not answered — marking as No Answer`);
                    const statusResult = await setCallStatus(recordId, 'No Answer', airtableConfig);
                    console.log(`📋 No Answer status: ${statusResult.success ? '✅ SUCCESS' : '❌ FAILED'}`);
                } else {
                    console.log(`\n📋 Saving to Airtable...`);
                    const saveResult = await saveDonationResults({
                        recordId,
                        transcript: transcriptionResult.transcript,
                        analysis: analysisResult.analysis,
                        airtableConfig
                    });
                    console.log(`📋 Save result: ${saveResult.success ? '✅ SUCCESS' : '❌ FAILED'}`);
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
