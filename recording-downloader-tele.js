// recording-downloader-tele.js — גרסת טלמרקטינג (מנותקת מתהליך הלידים הראשי)

const https = require('https');
const http = require('http');
const { URL } = require('url');

console.log('📋 Loading FIXED recording uploader...');

// 🔐 קונפיגורציה
const MASKYOO_CONFIG = {
    apiKey: 'process.env.MASKYOO_API_KEY',
    baseUrl: 'https://app.maskyoo.co.il/issa_153/api/'
};

// 🔗 Pabbly Webhook URL
const PABBLY_WEBHOOK_URL = 'https://connect.pabbly.com/workflow/sendwebhookdata/IjU3NjYwNTZhMDYzNTA0MzQ1MjZkNTUzNTUxMzAi_pc';

console.log('✅ Configuration loaded');

// 📖 קריאת קבצים קיימים מאיירטייבל
async function getExistingRecordingFiles(recordId, airtableConfig) {
    return new Promise((resolve, reject) => {
        console.log(`📖 Reading existing files from record ${recordId}...`);
        
        let tablePath = airtableConfig.tableId || 'tblABFOvI4cQSz3sg';
        
        const options = {
            hostname: 'api.airtable.com',
            port: 443,
            path: `/v0/${airtableConfig.baseId}/${tablePath}/${recordId}`,
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${airtableConfig.apiKey}`,
                'Content-Type': 'application/json'
            }
        };
        
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                try {
                    const result = JSON.parse(data);
                    
                    if (res.statusCode === 200) {
                        const existingFiles = result.fields['Recording File'] || [];
                        console.log(`📁 Found ${existingFiles.length} existing files`);
                        resolve(existingFiles);
                    } else {
                        console.log(`⚠️ Could not read existing files (${res.statusCode}), starting fresh`);
                        resolve([]);
                    }
                } catch (error) {
                    console.log(`⚠️ Error parsing response, starting fresh:`, error.message);
                    resolve([]);
                }
            });
        });
        
        req.on('error', (error) => {
            console.log(`⚠️ Error reading existing files, starting fresh:`, error.message);
            resolve([]);
        });
        
        req.end();
    });
}

// 🎵 הורדת קובץ ההקלטה ממסקיו
async function downloadRecordingFromMaskyoo(uuid, callInfo = null) {
    return new Promise((resolve, reject) => {
        console.log(`\n🎵 === DOWNLOADING RECORDING FROM MASKYOO ===`);
        console.log(`🆔 UUID: ${uuid}`);
        
        const postData = new URLSearchParams({
            service: 'get_record_by_call_uuid',
            call_uuid: uuid,
            type: 'mp3',
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
                'Content-Length': Buffer.byteLength(postData),
                'User-Agent': 'Recording-Downloader/1.0'
            }
        };

        console.log(`🔍 Downloading MP3 file...`);

        const req = https.request(options, (res) => {
            console.log(`📨 Maskyoo Response (${res.statusCode})`);
            
            if (res.statusCode !== 200) {
                let errorData = '';
                res.on('data', (chunk) => { errorData += chunk; });
                res.on('end', () => {
                    console.log(`❌ Download failed: ${errorData}`);
                    resolve({
                        success: false,
                        error: `HTTP ${res.statusCode}: ${errorData}`
                    });
                });
                return;
            }

            // איסוף הנתונים Binary
            let chunks = [];
            let totalLength = 0;

            res.on('data', (chunk) => {
                chunks.push(chunk);
                totalLength += chunk.length;
            });

            res.on('end', () => {
                const audioBuffer = Buffer.concat(chunks, totalLength);
                
                // יצירת שם קובץ ייחודי עם UUID (מניעת התנגשות בין שיחות מקביליות)
                const uuidSuffix = uuid ? uuid.replace('.', '-') : Date.now().toString(36);
                let filename;
                if (callInfo && callInfo.start_call) {
                    const callDate = new Date(callInfo.start_call);
                    const year = callDate.getFullYear();
                    const month = String(callDate.getMonth() + 1).padStart(2, '0');
                    const day = String(callDate.getDate()).padStart(2, '0');
                    const hours = String(callDate.getHours()).padStart(2, '0');
                    const minutes = String(callDate.getMinutes()).padStart(2, '0');
                    const seconds = String(callDate.getSeconds()).padStart(2, '0');

                    filename = `tele_${year}-${month}-${day}_${hours}-${minutes}-${seconds}_${uuidSuffix}.mp3`;
                    console.log(`📅 Filename with call date: ${filename}`);
                } else {
                    const now = new Date();
                    const year = now.getFullYear();
                    const month = String(now.getMonth() + 1).padStart(2, '0');
                    const day = String(now.getDate()).padStart(2, '0');
                    const hours = String(now.getHours()).padStart(2, '0');
                    const minutes = String(now.getMinutes()).padStart(2, '0');
                    const seconds = String(now.getSeconds()).padStart(2, '0');

                    filename = `tele_${year}-${month}-${day}_${hours}-${minutes}-${seconds}_${uuidSuffix}.mp3`;
                    console.log(`📅 Filename with current time: ${filename}`);
                }
                
                console.log(`✅ Downloaded ${totalLength} bytes`);
                console.log(`📁 File type: MP3 audio`);
                
                resolve({
                    success: true,
                    audioBuffer: audioBuffer,
                    size: totalLength,
                    contentType: 'audio/mpeg',
                    filename: filename
                });
            });
        });

        req.on('error', (error) => {
            console.error(`❌ Download Request Error:`, error);
            reject(error);
        });
        
        req.write(postData);
        req.end();
    });
}

async function uploadRecordingToAirtable(recordId, audioBuffer, filename, airtableConfig) {
    return new Promise(async (resolve, reject) => {
        console.log(`\n📤 === UPLOADING TO AIRTABLE (FILE SERVER METHOD) ===`);
        console.log(`📋 Record ID: ${recordId}`);
        console.log(`📁 Filename: ${filename}`);
        console.log(`📦 File size: ${audioBuffer.length} bytes`);
        
        if (!airtableConfig || !airtableConfig.apiKey || !airtableConfig.baseId) {
            console.log(`❌ Missing Airtable configuration`);
            resolve({ success: false, error: 'Missing Airtable configuration' });
            return;
        }

        try {
            // שלב 1: שמירת הקובץ בשרת זמנית
            const fs = require('fs');
            const tempFilePath = `/var/webhook-forwarder/recordings/${filename}`;
            
            console.log(`💾 Saving file temporarily: ${tempFilePath}`);
            fs.writeFileSync(tempFilePath, audioBuffer);
            console.log(`✅ File saved to server`);
            
            // שלב 2: יצירת URL
            const fileUrl = `https://leads.digim.co.il/recordings/${filename}`;
            console.log(`🔗 File URL: ${fileUrl}`);
            
            // שלב 3: קריאת קבצים קיימים
            console.log(`🔍 Checking existing files...`);
            const existingFiles = await getExistingRecordingFiles(recordId, airtableConfig);
            
            // שלב 4: הכנת attachment עם URL
            const newAttachment = {
                url: fileUrl,
                filename: filename
            };
            
            // שילוב עם קבצים קיימים
            const allAttachments = [...existingFiles, newAttachment];
            console.log(`📁 Total files: ${allAttachments.length} (${existingFiles.length} existing + 1 new)`);

            // שלב 5: שליחה לאיירטייבל
            const updateData = {
                fields: {
                    'Recording File': allAttachments
                }
            };

            console.log(`📝 Sending to Airtable...`);
            const postData = JSON.stringify(updateData);
            let tablePath = airtableConfig.tableId || 'tblABFOvI4cQSz3sg';
            
            const options = {
                hostname: 'api.airtable.com',
                port: 443,
                path: `/v0/${airtableConfig.baseId}/${tablePath}/${recordId}`,
                method: 'PATCH',
                headers: {
                    'Authorization': `Bearer ${airtableConfig.apiKey}`,
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(postData)
                }
            };
            
            const req = https.request(options, (res) => {
                let data = '';
                res.on('data', (chunk) => { data += chunk; });
                res.on('end', () => {
                    console.log(`📨 Airtable Response (${res.statusCode})`);
                    
                    try {
                        const result = JSON.parse(data);
                        
                        if (res.statusCode === 200) {
                            console.log(`✅ File uploaded successfully to Airtable!`);
                            
                            // שלב 6: מחיקת הקובץ הזמני אחרי דקה
                            setTimeout(() => {
                                try {
                                    fs.unlinkSync(tempFilePath);
                                    console.log(`🗑️ Temporary file deleted: ${filename}`);
                                } catch (error) {
                                    console.log(`⚠️ Could not delete temp file: ${error.message}`);
                                }
                            }, 600000);
                            
                            resolve({
                                success: true,
                                message: `Recording uploaded successfully`,
                                recordId,
                                filename,
                                fileUrl,
                                downloadUrls: allAttachments,
                                totalFiles: allAttachments.length,
                                size: audioBuffer.length,
                                result
                            });
                        } else {
                            console.error(`❌ Airtable upload failed (${res.statusCode}):`, result);
                            
                            // מחיקה גם במקרה של שגיאה
                            try { fs.unlinkSync(tempFilePath); } catch {}
                            
                            resolve({
                                success: false,
                                error: `Airtable API error (${res.statusCode}): ${data}`
                            });
                        }
                    } catch (error) {
                        console.error(`❌ Airtable response parse error:`, error.message);
                        try { fs.unlinkSync(tempFilePath); } catch {}
                        resolve({
                            success: false,
                            error: `Invalid response from Airtable: ${data}`
                        });
                    }
                });
            });
            
            req.on('error', (error) => {
                console.error(`❌ Airtable upload request error:`, error.message);
                try { fs.unlinkSync(tempFilePath); } catch {}
                resolve({
                    success: false,
                    error: error.message
                });
            });
            
            req.write(postData);
            req.end();
            
        } catch (error) {
            console.error(`❌ Upload process error:`, error.message);
            resolve({
                success: false,
                error: error.message
            });
        }
    });
}

// 📡 שליחת webhook לפאבלי
async function sendPabblyWebhook(webhookData) {
    return new Promise((resolve, reject) => {
        console.log(`\n📡 === SENDING PABBLY WEBHOOK ===`);
        console.log(`🔗 Webhook URL: ${PABBLY_WEBHOOK_URL}`);
        
        const postData = JSON.stringify(webhookData);
        const url = new URL(PABBLY_WEBHOOK_URL);
        
        const options = {
            hostname: url.hostname,
            port: url.port || (url.protocol === 'https:' ? 443 : 80),
            path: url.pathname + url.search,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData),
                'User-Agent': 'Recording-Downloader-Webhook/1.0'
            }
        };

        const requestModule = url.protocol === 'https:' ? https : http;
        
        const req = requestModule.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                console.log(`📨 Pabbly Response (${res.statusCode}): ${data}`);
                
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    console.log(`✅ Pabbly webhook sent successfully`);
                    resolve({
                        success: true,
                        statusCode: res.statusCode,
                        response: data
                    });
                } else {
                    console.error(`❌ Pabbly webhook failed (${res.statusCode})`);
                    resolve({
                        success: false,
                        statusCode: res.statusCode,
                        error: `HTTP ${res.statusCode}: ${data}`
                    });
                }
            });
        });
        
        req.on('error', (error) => {
            console.error(`❌ Pabbly webhook request error:`, error.message);
            resolve({
                success: false,
                error: error.message
            });
        });
        
        req.write(postData);
        req.end();
    });
}

// 🔄 תהליך מרכזי עם דיליי לפני הורדה
async function processRecordingDownload(jobData) {
    console.log(`\n🔄 === PROCESSING RECORDING DOWNLOAD (WITH DELAY) ===`);
console.log("🔍 DEBUG: Before JSON.stringify");
    console.log(`📋 Job Data: UUID=${jobData.uuid}, Record=${jobData.recordId}`);
console.log("🔍 DEBUG: After JSON.stringify");
    
    const { uuid, callInfo, airtableConfig, recordId, jobId } = jobData;
    
    if (!uuid) {
        console.error(`❌ No UUID provided`);
        return {
            success: false,
            step: 3,
            error: 'UUID is required'
        };
    }
    
    try {
        // 🕐 חישוב דיליי לפני הורדה - תיקון זמן ישראלי
        let waitTime = jobData.skipDelay ? 0 : 300000; // Skip delay for recovery
                
        if (callInfo && callInfo.end_call) {
            // תיקון: המרת זמן מסקיו לזמן ישראלי נכון
            const callEndTimeStr = callInfo.end_call.replace(' ', 'T') + '+03:00'; // הוספת timezone ישראלי
            const callEndTime = new Date(callEndTimeStr).getTime();
            const now = new Date().getTime();
            const timeSinceEnd = now - callEndTime;
            
            console.log(`⏰ Call ended: ${callInfo.end_call} (Israeli time)`);
console.log("🔍 DEBUG: After job data log");
            console.log(`⏰ Call ended converted: ${callEndTimeStr}`);
            console.log(`⏰ Now: ${new Date().toISOString()}`);
            console.log(`⏰ Time since call end: ${Math.round(timeSinceEnd/1000)} seconds`);
            
            // אם עברו פחות מ-5 דקות מסיום השיחה, נחכה
            if (timeSinceEnd < 300000 && timeSinceEnd > 0) {
                waitTime = 300000 - timeSinceEnd;
                console.log(`⏱️ Need to wait additional ${Math.round(waitTime/1000)} seconds for recording to be ready`);
            } else if (timeSinceEnd <= 0) {
                // זמן שלילי - שגיאה בחישוב, נחכה 2 דקות לבטיחות
                waitTime = 120000;
                console.log(`⚠️ Time calculation error (negative), waiting 2 minutes for safety`);
            } else {
                waitTime = 0;
                console.log(`✅ Recording should be ready (${Math.round(timeSinceEnd/1000)}s since end)`);
            }
        } else {
            console.log(`⏰ No call end time available, waiting 5 minutes for safety`);
        }
        
        // אם צריך לחכות - נעשה דיליי
        if (waitTime > 0) {
            console.log(`\n⏳ === WAITING ${Math.round(waitTime/1000)} SECONDS FOR RECORDING ===`);
            console.log(`🎵 Recording will be downloaded at: ${new Date(Date.now() + waitTime).toISOString()}`);
            
            await new Promise(resolve => setTimeout(resolve, waitTime));
            
            console.log(`✅ Wait completed - starting download now!`);
        }
        
        // שלב 1: הורדה (אחרי הדיליי!)
        console.log(`\n🎵 === STEP 3.1: DOWNLOAD FROM MASKYOO (AFTER DELAY) ===`);
        const downloadResult = await downloadRecordingFromMaskyoo(uuid, callInfo);
        
        if (!downloadResult.success) {
            console.log(`❌ Failed to download: ${downloadResult.error}`);
            return {
                success: false,
                step: 3,
                uuid,
                recordId,
                error: downloadResult.error
            };
        }
        
        console.log(`✅ Downloaded ${downloadResult.size} bytes`);
        
        // שלב 2: העלאה לאיירטייבל עם פורמט מתוקן
        console.log(`\n📤 === STEP 3.2: UPLOAD TO AIRTABLE (FIXED) ===`);
        let airtableResult = { success: false, error: 'No config' };
        
        if (airtableConfig && recordId) {
            airtableResult = await uploadRecordingToAirtable(
                recordId, 
                downloadResult.audioBuffer,
                downloadResult.filename,
                airtableConfig
            );
            console.log(`📤 Airtable upload result:`, airtableResult);
        }
        
        // שלב 3: webhook לפאבלי
        if (airtableResult.success) {
            console.log(`\n📡 === STEP 3.3: SEND PABBLY WEBHOOK ===`);
            
            const latestFile = airtableResult.downloadUrls[airtableResult.downloadUrls.length - 1];
            
            const webhookData = {
                uuid: uuid,
                record_id: recordId,
                job_id: jobId,
                recording: {
                    filename: downloadResult.filename,
                    download_url: latestFile.url,
                    size: downloadResult.size,
                    upload_status: 'uploaded'
                },
                call_info: {
                    uuid: uuid,
                    duration: callInfo?.call_duration || 'unknown',
                    start_time: callInfo?.start_call || 'unknown'
                },
                metadata: {
                    step: 3,
                    process: 'recording_upload_fixed',
                    timestamp: new Date().toISOString()
                }
            };
            
            const pabblyResult = await sendPabblyWebhook(webhookData);
            console.log(`📡 Pabbly result:`, pabblyResult);
        }
        
        console.log(`\n🎉 === STEP 3 COMPLETED SUCCESSFULLY ===`);
        console.log(`🆔 UUID: ${uuid}`);
        console.log(`📋 Record: ${recordId}`);
        console.log(`📁 File: ${downloadResult.filename} (${downloadResult.size} bytes)`);
        console.log(`📤 Airtable: ${airtableResult.success ? '✅ SUCCESS' : '❌ FAILED'}`);

console.log(`📤 Airtable: ${airtableResult.success ? '✅ SUCCESS' : '❌ FAILED'}`);
        
        // 🚀 STEP 4: קריאה לניתוח השיחה - הוסף כאן!
        if (airtableConfig && recordId && downloadResult.success) {
            console.log(`\n🚀 === STEP 4: TRIGGERING SPEECH ANALYSIS ===`);
            console.log(`🧠 Starting speech-analyzer.js...`);
            
            const analysisParams = {
                uuid: uuid,
                callInfo: callInfo,
                recordId: recordId,
                airtableConfig: airtableConfig,
recording: {
    filename: downloadResult.filename,
    filePath: `/var/webhook-forwarder/recordings/${downloadResult.filename}`,
    audioBuffer: "file_on_server", // placeholder
    size: downloadResult.size,
    downloadUrl: airtableResult.fileUrl || null
},
                timestamp: new Date().toISOString(),
                step: 4
            };
            
            try {
                const { spawn } = require('child_process'); // אם לא קיים בראש הקובץ
                
                const analyzerScript = jobData.analyzerScript || 'speech-analyzer.js';
                console.log(`🧠 Using analyzer: ${analyzerScript}`);
                const analyzer = spawn('node', [analyzerScript], {
                    cwd: '/var/webhook-forwarder',
                    stdio: ['pipe', 'pipe', 'pipe']
                });
                
                analyzer.stdin.write(JSON.stringify(analysisParams));
                analyzer.stdin.end();
                
                analyzer.stdout.on('data', (data) => {
                    console.log(`🧠 ANALYZER: ${data.toString().trim()}`);
                });
                
                analyzer.stderr.on('data', (data) => {
                    console.error(`❌ ANALYZER ERROR: ${data.toString().trim()}`);
                });
                
                analyzer.on('close', (code) => {
                    console.log(`📋 Speech analyzer finished with code: ${code}`);
                });
                
                console.log(`✅ Step 4 started: Speech analysis in progress`);
                
            } catch (error) {
                console.error(`❌ Failed to start speech analyzer:`, error.message);
            }
        } else {
            console.log(`⏭️ Step 4 skipped: Missing config or recording failed`);
        }
        
return {
            success: true,
            step: 3,
            uuid,
            recordId,
            speechAnalysisStarted: airtableConfig && recordId && downloadResult.success, // ✅ הוסף את זה!
            recording: {
                filename: downloadResult.filename,
                size: downloadResult.size,
                uploadStatus: airtableResult.success ? 'uploaded' : 'failed'
            },
            airtableUpload: airtableResult
        };
        
    } catch (error) {
        console.error(`\n💥 === STEP 3 ERROR ===`);
        console.error(`❌ Error:`, error.message);
        
        return {
            success: false,
            step: 3,
            uuid,
            recordId,
            error: error.message
        };
    }
}

// 📥 קריאה מ-stdin
if (require.main === module) {
    console.log('📥 === FIXED RECORDING DOWNLOADER STARTED ===');
    
    let inputData = '';
    
    process.stdin.on('data', (chunk) => {
        inputData += chunk.toString();
    });
    
    process.stdin.on('end', async () => {
        if (inputData.trim()) {
            try {
                const jobData = JSON.parse(inputData);
                console.log(`\n📥 === RECEIVED JOB ===`);
                console.log(`📋 Processing UUID: ${jobData.uuid}`);
                
                const result = await processRecordingDownload(jobData);
                
                console.log('\n📤 === FINAL RESULT ===');
                console.log(JSON.stringify(result));
if (result.speechAnalysisStarted) {
    console.log('🧠 Waiting for speech analysis to complete...');
    // תן לspeech-analyzer לרוץ ברקע
} else {
    process.exit(result.success ? 0 : 1);
}
                
            } catch (error) {
                console.error(`❌ Failed to parse job data:`, error.message);
                process.exit(1);
            }
        } else {
            console.log('📭 No input - test mode');
            console.log('✅ Fixed recording downloader ready');
        }
    });
    
    setTimeout(() => {
        if (!inputData) {
            console.log('⏰ Timeout - ready for production');
        }
    }, 1000);
}

module.exports = {
    downloadRecordingFromMaskyoo,
    uploadRecordingToAirtable,
    sendPabblyWebhook,
    processRecordingDownload
};

console.log('🚀 FIXED Recording downloader loaded and ready!');

