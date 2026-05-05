// uuid-tester-tele.js — גרסת טלמרקטינג (מנותקת מתהליך הלידים הראשי)

const https = require('https');
const { spawn } = require('child_process');

const MASKYOO_CONFIG = {
    apiKey: 'process.env.MASKYOO_API_KEY',
    baseUrl: 'https://app.maskyoo.co.il/issa_153/api/'
};

async function findCallUUID(phoneMyUser, phoneNumber, callTime) {
    return new Promise((resolve, reject) => {
        try {
            const utcDate = new Date(callTime);
            const israeliDate = new Date(utcDate.getTime() + 3 * 60 * 60 * 1000);
            const startTime = new Date(israeliDate.getTime() - 10 * 60000);
            const endTime = new Date(israeliDate.getTime() + 10 * 60000);
            const formatDate = (date) => date.toISOString().slice(0, 19).replace('T', ' ');
            
            const sqlQuery = `SELECT cdr_uniqueid, start_call, end_call, call_duration, cdr_ani, user_phone, call_status FROM webserviceview WHERE cdr_ddi = '${phoneMyUser}' AND (cdr_ani = '${phoneNumber}' OR user_phone = '${phoneNumber}') AND start_call >= '${formatDate(startTime)}' AND start_call <= '${formatDate(endTime)}' AND end_call IS NOT NULL ORDER BY start_call DESC LIMIT 1`;
            
            console.log('🔍 === STEP 2: UUID SEARCH ===');
            console.log('From:', phoneMyUser);
            console.log('To:', phoneNumber);
            console.log('Call Time:', callTime);
            console.log('Search Range:', formatDate(startTime), '→', formatDate(endTime));
            
            const params = new URLSearchParams({
                service: 'cdr_query',
                sql: sqlQuery,
                format: 'json'
            });

            const url = MASKYOO_CONFIG.baseUrl + '?' + params.toString();
            
            const options = {
                method: 'GET',
                headers: {
                    'Authorization': 'Bearer ' + MASKYOO_CONFIG.apiKey,
                    'User-Agent': 'UUID-Tester-Fixed/1.0'
                }
            };

            const req = https.request(url, options, (res) => {
                let data = '';
                res.on('data', (chunk) => {
                    data += chunk;
                });
                res.on('end', () => {
                    console.log('UUID Search Response:', data);
                    
                    try {
                        const jsonData = JSON.parse(data);
                        
                        if (jsonData.status && jsonData.status.code === 200 && jsonData.result && jsonData.result.length > 0) {
                            const callInfo = jsonData.result[0];
                            console.log('✅ UUID FOUND:', callInfo.cdr_uniqueid);

                            const isNoAnswer = (
                                callInfo.call_status === 'NO ANSWER' ||
                                callInfo.call_status === 'BUSY' ||
                                parseInt(callInfo.call_duration || 0) < 7
                            );
                            if (isNoAnswer) {
                                console.log(`📵 No Answer detected: status=${callInfo.call_status}, duration=${callInfo.call_duration}s`);
                                callInfo.no_answer = true;
                            }

                            resolve({
                                success: true,
                                uuid: callInfo.cdr_uniqueid,
                                callInfo: callInfo
                            });
                        } else {
                            console.log('❌ UUID NOT FOUND');
                            resolve({
                                success: false,
                                error: 'Call not found'
                            });
                        }
                    } catch (error) {
                        console.error('JSON Parse Error:', error.message);
                        reject(new Error('Invalid JSON response: ' + data));
                    }
                });
            });

            req.on('error', (error) => {
                console.error('UUID Search Request Error:', error);
                reject(error);
            });
            
            req.end();
            
        } catch (error) {
            console.error('findCallUUID Error:', error.message);
            reject(error);
        }
    });
}

async function updateAirtableWithUUID(recordId, uuid, airtableConfig, callInfo) {
    return new Promise((resolve, reject) => {
        try {
            console.log('📝 === UPDATING AIRTABLE ===');
            console.log('Record ID:', recordId);
            console.log('UUID:', uuid);

            if (!airtableConfig || !airtableConfig.apiKey || !airtableConfig.baseId) {
                console.log('❌ Missing Airtable configuration');
                resolve({
                    success: false,
                    error: 'Missing Airtable configuration'
                });
                return;
            }

            const updateData = {
                fields: {
                    UUID: uuid,
                    'Last UUID Update': new Date().toISOString(),
                    ...(callInfo?.call_duration ? { 'Call Duration': String(callInfo.call_duration) } : {}),
                    ...(callInfo?.no_answer ? { call_status: 'No Answer' } : {})
                }
            };
            
            console.log('Updating Airtable with data:', updateData);
            
            const postData = JSON.stringify(updateData);
            
            let tablePath = 'tblOGjzEG2Zw7WfAp';
            if (airtableConfig.tableId) {
                tablePath = airtableConfig.tableId;
            } else if (airtableConfig.tableName) {
                tablePath = encodeURIComponent(airtableConfig.tableName);
            }
            
            const options = {
                hostname: 'api.airtable.com',
                port: 443,
                path: '/v0/' + airtableConfig.baseId + '/' + tablePath + '/' + recordId,
                method: 'PATCH',
                headers: {
                    'Authorization': 'Bearer ' + airtableConfig.apiKey,
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(postData)
                }
            };
            
            const req = https.request(options, (res) => {
                let data = '';
                res.on('data', (chunk) => {
                    data += chunk;
                });
                res.on('end', () => {
                    console.log('Airtable Response:', data);
                    
                    try {
                        const result = JSON.parse(data);
                        
                        if (res.statusCode === 200) {
                            console.log('✅ Airtable updated successfully');
                            resolve({
                                success: true,
                                message: 'Record updated with UUID ' + uuid,
                                recordId: recordId,
                                uuid: uuid,
                                result: result
                            });
                        } else {
                            console.error('❌ Airtable update failed (' + res.statusCode + ')');
                            resolve({
                                success: false,
                                error: 'Airtable error: ' + data
                            });
                        }
                    } catch (error) {
                        console.error('Airtable response parse error:', error.message);
                        resolve({
                            success: false,
                            error: 'Invalid response: ' + data
                        });
                    }
                });
            });
            
            req.on('error', (error) => {
                console.error('Airtable request error:', error.message);
                resolve({
                    success: false,
                    error: error.message
                });
            });
            
            req.write(postData);
            req.end();
            
        } catch (error) {
            console.error('updateAirtableWithUUID Error:', error.message);
            resolve({
                success: false,
                error: error.message
            });
        }
    });
}

// 🔧 תיקון Race Condition - החלף את triggerRecordingDownload ב-uuid-tester.js

async function triggerRecordingDownload(uuid, callInfo, jobData) {
    console.log('🚀 === STEP 3: TRIGGERING RECORDING DOWNLOAD (RACE CONDITION FIX) ===');
    console.log('🎵 UUID:', uuid);
    
    const downloadParams = {
        uuid: uuid,
        callInfo: callInfo,
        recordId: jobData.recordId,
        airtableConfig: jobData.airtableConfig,
        jobId: jobData.jobId,
        analyzerScript: jobData.analyzerScript,
        timestamp: new Date().toISOString(),
        step: 3
    };
    
    console.log('📦 Download params:', JSON.stringify(downloadParams, null, 2));
    
    // 🔧 Promise wrapper לטיפול נכון באירועים
    return new Promise((resolve) => {
        try {
            console.log('🔧 DEBUG: About to spawn with race condition protection...');
            
            const downloader = spawn('node', ['recording-downloader-tele.js'], {
                cwd: '/var/webhook-forwarder',
                stdio: ['pipe', 'pipe', 'pipe'],
                env: process.env,
                // ✅ הוסף detached כדי למנוע orphan processes
                detached: false
            });
            
            console.log('🔧 DEBUG: Spawn executed, PID:', downloader.pid || 'null');
            
            let processEnded = false;
            let gotAnyOutput = false;
            let errorDetails = null;
            
            // ⚡ הגדרת timeout לפני event handlers (למניעת race condition)
            const timeoutId = setTimeout(() => {
                if (!processEnded) {
                    console.log('⏰ DEBUG: 60s timeout - process still running');
                    console.log('⏰ DEBUG: Got any output:', gotAnyOutput);
                    
                    if (!gotAnyOutput) {
                        console.log('⏰ DEBUG: No output received - likely crashed immediately');
                        console.log('⏰ DEBUG: Terminating silent process...');
                    }
                    
                    try {
                        downloader.kill('SIGTERM');
                    } catch (killError) {
                        console.log('⏰ DEBUG: Kill error:', killError.message);
                    }
                }
            }, 600000); // 10 דקות במקום 60 שניות
            
            // ✅ Event handlers עם race condition protection
            downloader.on('spawn', () => {
                console.log('✅ DEBUG: SPAWN EVENT - process started!');
            });
            
            downloader.on('error', (error) => {
                errorDetails = error;
                console.error('❌ DEBUG: ERROR EVENT:', error.code, error.message);
                console.error('❌ DEBUG: Error type:', typeof error, Object.keys(error));
            });
            
            downloader.stdout.on('data', (data) => {
                if (!gotAnyOutput) {
                    gotAnyOutput = true;
                    console.log('✅ DEBUG: First stdout received - process is alive!');
                }
                
                const output = data.toString().trim();
                console.log('📤 DEBUG: STDOUT:', output.substring(0, 200) + (output.length > 200 ? '...' : ''));
            });
            
            downloader.stderr.on('data', (data) => {
                if (!gotAnyOutput) {
                    gotAnyOutput = true;
                    console.log('⚠️ DEBUG: First stderr received - process started but has errors');
                }
                
                const error = data.toString().trim();
                console.error('❌ DEBUG: STDERR:', error.substring(0, 200) + (error.length > 200 ? '...' : ''));
            });
            
            downloader.on('close', (code, signal) => {
                processEnded = true;
                clearTimeout(timeoutId);
                
                console.log('🔧 DEBUG: CLOSE EVENT');
                console.log('🔧 DEBUG: Exit code:', code, 'Signal:', signal);
                console.log('🔧 DEBUG: Got any output:', gotAnyOutput);
                console.log('🔧 DEBUG: Had errors:', !!errorDetails);
                
                if (code === 0 && gotAnyOutput) {
                    console.log('✅ DEBUG: Process completed successfully');
                    resolve({
                        success: true,
                        message: 'Recording download completed',
                        params: downloadParams
                    });
                } else if (code === null && signal) {
                    console.log('⚠️ DEBUG: Process was terminated by signal:', signal);
                    resolve({
                        success: false,
                        message: 'Process terminated: ' + signal,
                        params: downloadParams
                    });
                } else if (!gotAnyOutput && !errorDetails) {
                    console.error('❌ DEBUG: SILENT CRASH - process died without output or errors');
                    console.error('❌ DEBUG: This usually means the spawned script has a syntax error or missing dependency');
                    resolve({
                        success: false,
                        message: 'Silent crash - check recording-downloader.js for syntax errors',
                        params: downloadParams
                    });
                } else {
                    console.error('❌ DEBUG: Process failed - code:', code, 'error:', errorDetails?.message);
                    resolve({
                        success: false,
                        message: `Process failed with code ${code}: ${errorDetails?.message || 'unknown error'}`,
                        params: downloadParams
                    });
                }
            });
            
            // ⚡ הוסף עיכוב קטן לפני שליחת הנתונים (למניעת race condition)
            setTimeout(() => {
                console.log('🔧 DEBUG: Writing JSON to stdin after 100ms delay...');
                try {
                    const jsonString = JSON.stringify(downloadParams);
                    downloader.stdin.write(jsonString);
                    downloader.stdin.end();
                    console.log('✅ DEBUG: JSON written successfully');
                } catch (writeError) {
                    console.error('❌ DEBUG: Error writing to stdin:', writeError.message);
                    downloader.kill();
                }
            }, 100);
            
        } catch (error) {
            console.error('💥 DEBUG: Exception in spawn setup:', error);
            console.error('💥 DEBUG: Stack:', error.stack);
            
            resolve({
                success: false,
                message: 'Spawn setup failed: ' + error.message,
                params: downloadParams
            });
        }
    });
}

async function processUUIDJob(jobData) {
    console.log('🔄 === PROCESSING UUID JOB ===');
    console.log('Job Data:', jobData);
    
    const recordId = jobData.recordId;
    const phoneMyUser = jobData.phoneMyUser;
    const phoneNumber = jobData.phoneNumber;
    const callTime = jobData.callTime;
    const uuid = jobData.uuid;
    const callInfo = jobData.callInfo;
    const airtableConfig = jobData.airtableConfig;
    
    try {
        let uuidResult;
        
        if (uuid) {
            console.log('✅ UUID already provided:', uuid);
            uuidResult = {
                success: true,
                uuid: uuid,
                callInfo: callInfo
            };
        } else {
            console.log('🔍 Searching for UUID...');
            uuidResult = await findCallUUID(phoneMyUser, phoneNumber, callTime);
        }
        
        if (uuidResult.success) {
            console.log('✅ === UUID FOUND:', uuidResult.uuid, '===');

            const airtableResult = await updateAirtableWithUUID(recordId, uuidResult.uuid, airtableConfig, uuidResult.callInfo);
            console.log('Airtable update result:', airtableResult);

            if (uuidResult.callInfo?.no_answer) {
                console.log('📵 No Answer — pipeline stopped, record updated');
                return {
                    success: true,
                    step: 2,
                    recordId: recordId,
                    uuid: uuidResult.uuid,
                    no_answer: true
                };
            }

            const downloadResult = await triggerRecordingDownload(uuidResult.uuid, uuidResult.callInfo, jobData);
            console.log('Download trigger result:', downloadResult);
            
            console.log('🎉 === STEP 2 COMPLETED SUCCESSFULLY ===');
            console.log('Record:', recordId);
            console.log('UUID:', uuidResult.uuid);
            
            return {
                success: true,
                step: 2,
                recordId: recordId,
                uuid: uuidResult.uuid,
                airtableUpdate: airtableResult,
                downloadTrigger: downloadResult
            };
            
        } else {
            console.log('❌ === UUID NOT FOUND ===');
            console.log('Record:', recordId);
            console.log('Error:', uuidResult.error);
            
            return {
                success: false,
                step: 2,
                recordId: recordId,
                error: uuidResult.error
            };
        }
        
    } catch (error) {
        console.error('💥 === STEP 2 ERROR ===');
        console.error('Error:', error.message);
        
        return {
            success: false,
            step: 2,
            recordId: recordId,
            error: error.message
        };
    }
}

async function runStandalone() {
    console.log('🧪 === STANDALONE UUID TEST ===');
    
    const testJobData = {
        recordId: 'test-record-123',
        phoneMyUser: '972738020249',
        phoneNumber: '972559185678',
        callTime: '2025-07-21T13:36:46.107Z',
        jobId: 'test-job-123'
    };
    
    const result = await processUUIDJob(testJobData);
    console.log('Test Result:', result);
}

if (require.main === module) {
    let inputData = '';
    
    process.stdin.on('data', (chunk) => {
        inputData += chunk.toString();
    });
    
    process.stdin.on('end', async () => {
        if (inputData.trim()) {
            try {
                const jobData = JSON.parse(inputData);
                console.log('📥 === RECEIVED JOB FROM WEBHOOK-FORWARDER ===');
                
                const result = await processUUIDJob(jobData);
                
                console.log(JSON.stringify(result));
                process.exit(result.success ? 0 : 1);
                
            } catch (error) {
                console.error('Failed to parse job data:', error.message);
                process.exit(1);
            }
        } else {
            await runStandalone();
        }
    });
    
    setTimeout(() => {
        if (!inputData) {
            runStandalone().catch(console.error);
        }
    }, 1000);
}

module.exports = {
    findCallUUID: findCallUUID,
    updateAirtableWithUUID: updateAirtableWithUUID,
    triggerRecordingDownload: triggerRecordingDownload,
    processUUIDJob: processUUIDJob
};
