// 🔧 שרת מתוקן - 3 שלבים: שיחה → UUID → הורדה
// גרסה 3.7.0 - Clean Flow

const express = require('express');
const cors = require('cors');
const https = require('https');
const { spawn } = require('child_process');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// 🔐 קונפיגורציה
const MASKYOO_CONFIG = {
    apiKey: 'process.env.MASKYOO_API_KEY',
    baseUrl: 'https://app.maskyoo.co.il/issa_153/api/'
};

const SECRET_KEY = process.env.SECRET_KEY || 'mK9vR3pQ8nX2fA7sB1cD4eF6gH5jL0mN';

// ⏰ הגדרות זמן לחיפוש UUID
const AUTO_UUID_CONFIG = {
    initialDelay: 5 * 60 * 1000,        // 5 דקות
    checkInterval: 5 * 60 * 1000,       // כל 5 דקות  
    maxDuration: 30 * 60 * 1000,        // 30 דקות סה"כ
    maxAttempts: 6                      // 6 ניסיונות
};

// 📊 מעקב אחר תהליכים
const activeJobs = new Map();
const jobStats = {
    activeJobs: 0,
    completedJobs: 0,
    failedJobs: 0,
    timeoutJobs: 0
};

// Middleware
app.use(cors());
app.use(express.json());

// 🔒 בדיקת אבטחה
function verifySecretKey(req, res, next) {
    const providedKey = req.headers['x-secret-key'];
    if (providedKey !== SECRET_KEY) {
        return res.status(401).json({
            success: false,
            error: 'Unauthorized - invalid secret key'
        });
    }
    next();
}

// 📱 פרמוט מספר טלפון
function formatPhoneNumber(phoneNumber) {
    let cleaned = String(phoneNumber).replace(/\D/g, '');
    if (cleaned.startsWith('0')) return `972${cleaned.substring(1)}`;
    if (!cleaned.startsWith('972')) return `972${cleaned}`;
    // Fix: remove extra 0 after country code (e.g., 9720525... → 972525...)
    if (cleaned.startsWith('9720')) return '972' + cleaned.substring(4);
    return cleaned;
}

// 📡 שליחה למסקיו - שלב 1
async function sendToMaskyoo(phoneNumber, phoneMyUser) {
    return new Promise((resolve, reject) => {
        const params = new URLSearchParams({
            service: 'create_maskyoo_call_v2',
            maskyoo1: phoneMyUser,
            destination1: phoneMyUser,
            destination2: phoneNumber,
            format: 'json'
        });

        const url = `${MASKYOO_CONFIG.baseUrl}?${params.toString()}`;
        
        console.log('\n📡 === STEP 1: MASKYOO CALL ===');
        console.log(`📱 From: ${phoneMyUser} → To: ${phoneNumber}`);
        console.log(`🔗 URL: ${url.substring(0, 100)}...`);

        const options = {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${MASKYOO_CONFIG.apiKey}`,
                'User-Agent': 'Webhook-Forwarder-Fixed/3.7'
            }
        };

        const req = https.request(url, options, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                console.log(`📨 Maskyoo Response: ${data}`);
                
                try {
                    const jsonData = JSON.parse(data);
                    
                    if (jsonData.status?.code === 200) {
                        console.log(`✅ STEP 1 SUCCESS: Call sent to Maskyoo!`);
                        resolve({ status: res.statusCode, data: jsonData });
                    } else {
                        console.log(`❌ STEP 1 FAILED:`, jsonData.status);
                        resolve({ status: res.statusCode, data: jsonData });
                    }
                    
                } catch (error) {
                    console.error(`❌ JSON Parse Error:`, error.message);
                    reject(new Error(`Invalid JSON response: ${data}`));
                }
            });
        });

        req.on('error', (error) => {
            console.error(`💥 REQUEST ERROR:`, error);
            reject(error);
        });

        req.setTimeout(30000, () => {
            console.error(`⏰ REQUEST TIMEOUT after 30 seconds`);
            req.abort();
            reject(new Error('Request timeout'));
        });

        req.end();
    });
}

// 🔍 חיפוש UUID - שלב 2 (מתוקן!)
// 🔍 חיפוש UUID - שלב 2 (מתוקן עם זיהוי DST!)
async function findCallUUID(phoneMyUser, phoneNumber, callTime) {
    return new Promise((resolve, reject) => {
        // המרת זמן מUTC לזמן ישראלי - זיהוי אוטומטי של UTC+2/+3
        const utcDate = new Date(callTime);
        
        // חישוב ההפרש בין UTC לזמן ישראלי (משתנה לפי DST)
        const israeliTimeStr = utcDate.toLocaleString('en-US', {
            timeZone: 'Asia/Jerusalem',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false
        });
        
        // המר את המחרוזת לזמן UTC כדי לחשב את ההפרש
        const israeliDate = new Date(israeliTimeStr);
        const offsetMs = israeliDate.getTime() - utcDate.getTime();
        
        // יצירת זמנים ישראליים עם ההפרש הנכון
        const callTimeIsraeli = new Date(utcDate.getTime() + offsetMs);
        const startTime = new Date(callTimeIsraeli.getTime() - 10 * 60000);
        const endTime = new Date(callTimeIsraeli.getTime() + 10 * 60000);
        
        // פורמט תאריך לשאילתה
        const formatDate = (date) => {
            const y = date.getFullYear();
            const m = String(date.getMonth() + 1).padStart(2, '0');
            const d = String(date.getDate()).padStart(2, '0');
            const h = String(date.getHours()).padStart(2, '0');
            const min = String(date.getMinutes()).padStart(2, '0');
            const s = String(date.getSeconds()).padStart(2, '0');
            return `${y}-${m}-${d} ${h}:${min}:${s}`;
        };
        
        // 🔧 השאילתה המתוקנת - השדות הנכונים!
        const sqlQuery = `
            SELECT cdr_uniqueid, start_call, end_call, call_duration, cdr_ani, user_phone, call_status
            FROM webserviceview
            WHERE cdr_ddi = '${phoneMyUser}'
            AND (cdr_ani = '${phoneNumber}' OR user_phone = '${phoneNumber}')
            AND start_call >= '${formatDate(startTime)}'
            AND start_call <= '${formatDate(endTime)}'
            AND end_call IS NOT NULL
            ORDER BY start_call DESC
            LIMIT 1
        `;
        
        console.log('\n🔍 === STEP 2: UUID SEARCH (DST-AWARE) ===');
        console.log(`📱 From (cdr_ani): ${phoneMyUser}`);
        console.log(`📱 To (user_phone): ${phoneNumber}`);
        console.log(`⏰ UTC time: ${utcDate.toISOString()}`);
        console.log(`⏰ Israeli time: ${formatDate(callTimeIsraeli)}`);
        console.log(`⏰ Offset: ${offsetMs / 3600000} hours`);
        console.log(`🔍 Search range: ${formatDate(startTime)} → ${formatDate(endTime)}`);
        
        const params = new URLSearchParams({
            service: 'cdr_query',
            sql: sqlQuery,
            format: 'json'
        });

        const url = `${MASKYOO_CONFIG.baseUrl}?${params.toString()}`;
        
        const options = {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${MASKYOO_CONFIG.apiKey}`,
                'User-Agent': 'UUID-Search-Fixed/3.7'
            }
        };

        const req = https.request(url, options, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                console.log(`📨 UUID Search Response: ${data}`);
                
                try {
                    const jsonData = JSON.parse(data);
                    
                    if (jsonData.status?.code === 200 && jsonData.result && jsonData.result.length > 0) {
                        const callInfo = jsonData.result[0];
                        console.log(`✅ STEP 2 SUCCESS: UUID FOUND: ${callInfo.cdr_uniqueid}`);
                        
                        resolve({
                            success: true,
                            uuid: callInfo.cdr_uniqueid,
                            callInfo: callInfo
                        });
                    } else {
                        console.log(`❌ STEP 2: UUID NOT FOUND`);
                        resolve({
                            success: false,
                            error: 'Call not found with fixed search'
                        });
                    }
                } catch (error) {
                    console.error(`❌ UUID Search JSON Error:`, error.message);
                    reject(new Error(`Invalid JSON response: ${data}`));
                }
            });
        });

        req.on('error', (error) => {
            console.error(`❌ UUID Search Request Error:`, error);
            reject(error);
        });
        
        req.end();
    });
}

// 🚀 קריאה לקובץ UUID-TESTER - שלב 2
async function triggerUUIDSearch(jobData) {
    return new Promise((resolve, reject) => {
        console.log('\n🚀 === STEP 2: TRIGGERING UUID-TESTER ===');
        console.log(`📂 Launching uuid-tester.js with job data:`, jobData);
        
        const uuidTester = spawn('node', ['uuid-tester.js'], {
            cwd: '/var/webhook-forwarder',
            stdio: ['pipe', 'pipe', 'pipe']
        });
        
        // שליחת הנתונים ל-stdin
        uuidTester.stdin.write(JSON.stringify(jobData));
        uuidTester.stdin.end();
        
        let output = '';
        let error = '';
        
        uuidTester.stdout.on('data', (data) => {
            output += data.toString();
            console.log(`📤 UUID-TESTER: ${data.toString().trim()}`);
        });
        
        uuidTester.stderr.on('data', (data) => {
            error += data.toString();
            console.error(`❌ UUID-TESTER ERROR: ${data.toString().trim()}`);
        });
        
        uuidTester.on('close', (code) => {
            console.log(`📋 UUID-TESTER finished with code: ${code}`);
            
            if (code === 0) {
                console.log(`✅ STEP 2 SUCCESS: UUID search completed`);
                resolve({ success: true, output });
            } else {
                console.error(`❌ STEP 2 FAILED: UUID search failed with code ${code}`);
                resolve({ success: false, error, code });
            }
        });
        
        uuidTester.on('error', (err) => {
            console.error(`💥 UUID-TESTER SPAWN ERROR:`, err);
            reject(err);
        });
    });
}

// 🔄 תהליך אוטומטי עם UUID Search
async function autoUUIDSearch(jobData) {
    const { recordId, phoneMyUser, phoneNumber, callTime, jobId } = jobData;
    
    console.log(`\n🤖 === AUTO UUID PROCESS STARTED ===`);
    console.log(`🆔 Job ID: ${jobId}`);
    console.log(`📋 Record ID: ${recordId}`);
    
    let attempts = 0;
    const startTime = Date.now();
    
    const searchInterval = setInterval(async () => {
        attempts++;
        const elapsedTime = Date.now() - startTime;
        
        console.log(`\n🔍 === UUID SEARCH ATTEMPT ${attempts}/${AUTO_UUID_CONFIG.maxAttempts} ===`);
        
        try {
            // קריאה ישירה לפונקציית חיפוש UUID המתוקנת
            const result = await findCallUUID(phoneMyUser, phoneNumber, callTime);
            
            if (result.success) {
                // UUID נמצא! עכשיו נפעיל את uuid-tester.js
                console.log(`\n🎉 === UUID FOUND! MOVING TO STEP 2 ===`);
                console.log(`🆔 UUID: ${result.uuid}`);
                
                clearInterval(searchInterval);
                activeJobs.delete(recordId);
                jobStats.activeJobs--;
                jobStats.completedJobs++;
                
                // הפעלת קובץ uuid-tester.js
                const uuidResult = await triggerUUIDSearch({
                    ...jobData,
                    uuid: result.uuid,
                    callInfo: result.callInfo,
                    foundAt: new Date().toISOString()
                });
                
                if (uuidResult.success) {
                    console.log(`✅ FULL PROCESS SUCCESS: ${recordId}`);
                } else {
                    console.log(`⚠️ UUID found but processing failed: ${recordId}`);
                }
                
            } else if (attempts >= AUTO_UUID_CONFIG.maxAttempts || elapsedTime >= AUTO_UUID_CONFIG.maxDuration) {
                // זמן נגמר
                console.log(`\n⏰ === UUID SEARCH TIMEOUT ===`);
                console.log(`📋 Record ID: ${recordId}`);
                
                clearInterval(searchInterval);
                activeJobs.delete(recordId);
                jobStats.activeJobs--;
                jobStats.timeoutJobs++;
                
            } else {
                // ממשיך לחפש
                console.log(`⏳ UUID not found yet, continuing search...`);
            }
            
        } catch (error) {
            console.error(`❌ UUID Search Error:`, error.message);
            
            if (attempts >= AUTO_UUID_CONFIG.maxAttempts) {
                clearInterval(searchInterval);
                activeJobs.delete(recordId);
                jobStats.activeJobs--;
                jobStats.failedJobs++;
            }
        }
    }, AUTO_UUID_CONFIG.checkInterval);
    
    // שמירת התהליך
    activeJobs.set(recordId, {
        jobId,
        interval: searchInterval,
        startTime,
        attempts,
        phoneMyUser,
        phoneNumber,
        callTime,
        status: 'active'
    });
    
    jobStats.activeJobs++;
}

// 💚 Health check
app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        server: 'webhook-forwarder-fixed',
        version: '3.7.0',
        features: {
            threeStepFlow: true,
            fixedUUIDSearch: true,
            israeliTime: true,
            modularDesign: true
        },
        jobs: jobStats,
        maskyoo: {
            baseUrl: MASKYOO_CONFIG.baseUrl,
            apiKeyConfigured: !!MASKYOO_CONFIG.apiKey
        }
    });
});

// 📞 Endpoint ראשי - שיחה מתוקנת
app.post('/maskyoo-call', verifySecretKey, async (req, res) => {
    const startTime = Date.now();
    console.log('\n🚀 === NEW CALL REQUEST - 3 STEP FLOW ===');
    console.log(`⏰ Time: ${new Date().toISOString()}`);
    console.log('📋 Request body:', JSON.stringify(req.body, null, 2));

    try {
        const { phoneNumber, phoneMyUser, recordId, timestamp, airtableConfig } = req.body;

        if (!phoneNumber || !phoneMyUser) {
            throw new Error('Missing required fields: phoneNumber and phoneMyUser');
        }

        const formattedPhone = formatPhoneNumber(phoneNumber);
        const formattedPhoneMyUser = formatPhoneNumber(phoneMyUser);

        console.log('\n📱 === CALL DETAILS ===');
        console.log(`📞 From: ${formattedPhoneMyUser} → To: ${formattedPhone}`);
        console.log(`📋 Record ID: ${recordId}`);

        // 🚀 STEP 1: שליחה למסקיו
        const maskyooResponse = await sendToMaskyoo(formattedPhone, formattedPhoneMyUser);

        if (maskyooResponse.data.status?.code === 200) {
            console.log('\n✅ === STEP 1 COMPLETED: CALL SENT ===');
            
            // 🚀 STEP 2: התחלת חיפוש UUID אוטומטי (אם יש recordId)
            if (recordId) {
                const jobId = `auto-uuid-${recordId}-${Date.now()}`;
                console.log(`\n🚀 === STARTING STEP 2: UUID SEARCH ===`);
                console.log(`🤖 Job ID: ${jobId}`);
                
                // המתנה ראשונית
                setTimeout(() => {
                    autoUUIDSearch({
                        recordId,
                        phoneMyUser: formattedPhoneMyUser,
                        phoneNumber: formattedPhone,
                        callTime: timestamp,
                        jobId,
                        airtableConfig: airtableConfig // העברת פרטי איירטייבל
                    });
                }, AUTO_UUID_CONFIG.initialDelay);
                
                console.log(`⏰ Step 2 will start in ${AUTO_UUID_CONFIG.initialDelay/60000} minutes`);
            }
            
            // תשובה מהירה לאיירטייבל
            const response = {
                success: true,
                message: `Call sent successfully - 3-step flow initiated`,
                callData: {
                    call_id: maskyooResponse.data.result?.call_id || recordId,
                    status: "call in progress",
                    from_number: formattedPhoneMyUser,
                    to_number: formattedPhone,
                    timestamp: timestamp,
                    processing_time_ms: Date.now() - startTime
                },
                flow: {
                    step1: "✅ Call sent to Maskyoo",
                    step2: recordId ? "🔄 UUID search will start in 5 minutes" : "⏭️ Skipped (no recordId)",
                    step3: "⏳ Recording download (after UUID found)"
                },
                forwarder: {
                    server_version: '3.7.0-fixed',
                    three_step_flow: true,
                    uuid_search_fixed: true
                }
            };
            
            console.log('\n📤 === SENDING RESPONSE TO AIRTABLE ===');
            res.json(response);

        } else {
            const errorMsg = maskyooResponse.data.status?.description || 'Unknown Maskyoo API error';
            console.error('\n❌ === STEP 1 FAILED ===');
            console.error(`💥 Error: ${errorMsg}`);
            
            res.status(400).json({
                success: false,
                error: `Maskyoo API error: ${errorMsg}`,
                callDetails: {
                    from_number: formattedPhoneMyUser,
                    to_number: formattedPhone
                },
                maskyooResponse: maskyooResponse.data
            });
        }

    } catch (error) {
        console.error('\n💥 === SERVER ERROR ===');
        console.error(`❌ Error: ${error.message}`);
        
        res.status(500).json({
            success: false,
            error: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

// 📊 סטטוס תהליכים
app.get('/auto-uuid-status', verifySecretKey, (req, res) => {
    const jobs = Array.from(activeJobs.entries()).map(([recordId, job]) => ({
        recordId,
        jobId: job.jobId,
        status: job.status,
        attempts: job.attempts,
        elapsedTime: Math.round((Date.now() - job.startTime) / 1000),
        remainingTime: Math.max(0, Math.round((AUTO_UUID_CONFIG.maxDuration - (Date.now() - job.startTime)) / 1000))
    }));

    res.json({
        success: true,
        stats: jobStats,
        jobs: jobs,
        timestamp: new Date().toISOString()
    });
});

// 🚀 הפעלת השרת
app.listen(PORT, '0.0.0.0', () => {
    console.log('\n🚀 === FIXED WEBHOOK FORWARDER - 3 STEP FLOW ===');
    console.log(`📍 Port: ${PORT}`);
    console.log(`🌐 Health: http://localhost:${PORT}/health`);
    console.log(`📞 Call: http://localhost:${PORT}/maskyoo-call`);
    console.log(`📊 Status: http://localhost:${PORT}/auto-uuid-status`);
    console.log('\n🔧 Fixed Features:');
    console.log('   ✅ Step 1: Call to Maskyoo');
    console.log('   ✅ Step 2: UUID search (fixed SQL + Israeli time)');
    console.log('   ✅ Step 3: Recording download (ready)');
    console.log('   ✅ Modular design - files don\'t block each other');
    console.log('\n📋 Flow:');
    console.log('   📞 webhook-forwarder.js → 🔍 uuid-tester.js → 🎵 recording-downloader.js');
    console.log('\n⏰ Started:', new Date().toISOString());
    console.log('📝 Ready for 3-step flow!\n');
});

// 📁 Temporary: Serve recording files for testing
app.use('/recordings', express.static('/var/webhook-forwarder/recordings'));
console.log('📁 Static files endpoint added for recordings');
