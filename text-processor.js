// 🧹 Text Processor (v2.0) - Handles long transcripts (1-2 hours)
const https = require('https');

console.log('🧹 Text processor module loaded (Advanced Chunking Enabled)');

const OPENAI_CONFIG = {
    apiKey: process.env.OPENAI_API_KEY || (() => { try { return require('fs').readFileSync(require('path').join(__dirname, '.openai-key'), 'utf8').trim(); } catch { return ''; } })(), // env, else .openai-key
    model: 'gpt-4o', // מודל חזק ומהיר יותר
    baseUrl: 'api.openai.com'
};

/**
 * 🛠 פונקציית עזר לפיצול טקסט חכם
 * מוודאת שלא חותכים באמצע משפט
 */
function splitIntoChunks(text, maxChars = 12000) {
    const chunks = [];
    let currentPos = 0;

    while (currentPos < text.length) {
        let endPos = currentPos + maxChars;
        
        if (endPos < text.length) {
            // מחפש נקודה או ירידת שורה קרובה כדי לא לחתוך משפט
            const lastSentenceEnd = text.lastIndexOf('.', endPos);
            const lastNewline = text.lastIndexOf('\n', endPos);
            const bestBreak = Math.max(lastSentenceEnd, lastNewline);
            
            if (bestBreak > currentPos + (maxChars * 0.5)) {
                endPos = bestBreak + 1;
            }
        }
        
        chunks.push(text.substring(currentPos, endPos).trim());
        currentPos = endPos;
    }
    return chunks;
}

/**
 * 🌐 פונקציה גנרית לביצוע קריאות ל-OpenAI
 */
async function callOpenAI(systemPrompt, userPrompt, maxTokens = 4000) {
    return new Promise((resolve, reject) => {
        const postData = JSON.stringify({
            model: OPENAI_CONFIG.model,
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: userPrompt }
            ],
            temperature: 0.3,
            max_tokens: maxTokens
        });

        const options = {
            hostname: OPENAI_CONFIG.baseUrl,
            port: 443,
            path: '/v1/chat/completions',
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${OPENAI_CONFIG.apiKey}`,
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData)
            }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                if (res.statusCode !== 200) {
                    return reject(new Error(`API Error ${res.statusCode}: ${data}`));
                }
                try {
                    const result = JSON.parse(data);
                    resolve(result.choices[0].message.content.trim());
                } catch (e) { reject(e); }
            });
        });

        req.on('error', (e) => reject(e));
        req.write(postData);
        req.end();
    });
}

// 🛡️ שמירה מפני הזיה: אם בתמלול הגולמי אין שיחה אמיתית (שקט → ה-ASR מחזיר את
// ה-prompt שלו; לולאת מילה אחת; כמעט אין מילים) — אסור להעביר אותו ל-LLM, כי הוא
// ימציא שיחה מזויפת. במקרה כזה מחזירים את הקלט כמו שהוא ומסמנים degenerate.
function isDegenerateTranscript(transcript) {
    const s = (transcript || '').trim();
    if (s.length < 25) return true;                                     // ריק למעשה
    if (/יש לפסק משפטים ולהוסיף סימני פיסוק/.test(s) && s.length < 200) return true; // prompt-echo על שקט
    const words = s.split(/\s+/).filter(Boolean);
    if (words.length < 8) return true;                                  // מעט מדי מילים
    if (new Set(words).size < 6) return true;                           // לולאת מילה אחת (הלו הלו…)
    return false;
}

const CLEAN_PROMPT = `אתה עורך מקצועי של תמלולים אוטומטיים של שיחות טלפון (מכירה / גיוס תרומות / שירות) בעברית.
תפקידך לנקות ולסדר את התמלול — לא לכתוב אותו מחדש.
תקן:
1. אותיות/מילים כפולות מיותרות ולולאות חזרה (אאאני → אני; רצף "מה מה מה" חוזר → הסר את החזרה)
2. פיסוק חסר/שגוי — הוסף נקודות, פסיקים וסימני שאלה נכונים
3. שגיאות כתיב/הקלדה ומילים שנשמעו לא נכון
4. חלק לפסקאות לפי מעבר דובר/נושא
כללי ברזל:
- אל תמציא, אל תוסיף ואל תשלים תוכן שלא נאמר. אל תכתוב שיחה חדשה.
- אם אין בקלט שיחה אמיתית (רק רעש / מילים בודדות / חזרה ריקה) — החזר את הקלט כפי שהוא, בלי להוסיף דבר.
- שמור על כל התוכן ועל העברית המקורית. אל תקצר ואל תסכם.
- החזר רק את הטקסט המנוקה, ללא הסברים או הערות.`;

/**
 * 🧹 ניקוי תמלול ארוך (חלק אחר חלק)
 */
async function cleanTranscript(transcript) {
    console.log(`\n🧹 === CLEANING TRANSCRIPT (${(transcript || '').length} chars) ===`);
    // לעולם לא לתת למודל להמציא שיחה מתוך שקט/רעש.
    if (isDegenerateTranscript(transcript)) {
        console.log('   ⏭️ Degenerate transcript (silence/echo/loop) — skipping cleanup, returning raw.');
        return { success: true, cleanedText: (transcript || '').trim(), degenerate: true };
    }
    const chunks = splitIntoChunks(transcript);
    let cleanedText = "";
    for (let i = 0; i < chunks.length; i++) {
        console.log(`   Processing chunk ${i + 1}/${chunks.length}...`);
        let done = false;
        for (let attempt = 1; attempt <= 2 && !done; attempt++) {
            try {
                const result = await callOpenAI(CLEAN_PROMPT, chunks[i], 8000);
                cleanedText += result + "\n\n";
                done = true;
            } catch (err) {
                console.error(`❌ Error in chunk ${i} (attempt ${attempt}):`, err.message);
                if (attempt === 2) cleanedText += chunks[i] + "\n\n"; // שמירת המקור אחרי ניסיון חוזר
            }
        }
    }
    return { success: true, cleanedText: cleanedText.trim() };
}

/**
 * 📝 סיכום תמלול ארוך (שיטת Map-Reduce) - גרסת 3 שורות
 */
async function summarizeTranscript(cleanedText) {
    console.log(`\n📝 === SUMMARIZING TRANSCRIPT ===`);
    const chunks = splitIntoChunks(cleanedText, 15000);
    let partialSummaries = [];

    // שלב 1: סיכום כל חלק (נשאר אותו דבר כדי לא לאבד מידע)
    for (let i = 0; i < chunks.length; i++) {
        console.log(`   Summarizing part ${i + 1}/${chunks.length}...`);
        const prompt = `תמצת את הנקודות העיקריות בקטע הבא ב-2-3 משפטים קצרים.`;
        const summary = await callOpenAI(prompt, chunks[i], 500);
        partialSummaries.push(summary);
    }

    // שלב 2: ה"צמצום" הסופי (Reduce) - כאן קורה הקסם
    console.log(`   Creating final 3-line summary...`);
    
    const finalPrompt = `אתה עורך חדשות מקצועי שמתמחה בתמציתיות קיצונית. 
    עליך לסכם את כל הנקודות הבאות ל-3 שורות בלבד (לא יותר!).
    כל שורה צריכה להציג נושא מרכזי אחר מהשיעור. 
    אל תכתוב כותרות, אל תכתוב "הסיכום הוא", פשוט 3 שורות של תוכן נטו.`;

    const finalSummary = await callOpenAI(finalPrompt, partialSummaries.join("\n\n"), 300);

    return { success: true, summary: finalSummary };
}

/**
 * 🔄 הפונקציה הראשית שמאחדת הכל
 */
async function cleanAndSummarizeTranscript(transcript) {
    try {
        // ניקוי
        const cleanRes = await cleanTranscript(transcript);
        
        // סיכום
        const summaryRes = await summarizeTranscript(cleanRes.cleanedText);
        
        return {
            success: true,
            cleanedText: cleanRes.cleanedText,
            summary: summaryRes.summary
        };
    } catch (error) {
        console.error("💥 Critical Process Error:", error);
        return { success: false, error: error.message };
    }
}

module.exports = {
    cleanTranscript,
    summarizeTranscript,
    cleanAndSummarizeTranscript
};