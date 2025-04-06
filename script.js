// --- ייבוא מהספרייה ---
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.1';

// הגדרות סביבה
env.allowLocalModels = false;
env.allowRemoteModels = true;

// --- קבלת רפרנסים לאלמנטים ב-HTML ---
const videoFileInput = document.getElementById('videoFile');
const statusDiv = document.getElementById('status');
const progressBar = document.getElementById('progressBar');
const languageSelect = document.getElementById('languageSelect');
// *** שינוי: רפרנסים לשני קישורי ההורדה ***
const downloadLinkSrt = document.getElementById('downloadLinkSrt');
const downloadLinkTxt = document.getElementById('downloadLinkTxt');
const downloadButtonsDiv = document.getElementById('downloadButtons'); // ה-div שעוטף


// --- הגדרות תמלול ---
const MODEL_NAME = 'Xenova/whisper-tiny';
const TARGET_SAMPLE_RATE = 16000;
const TASK = 'transcribe';

// --- פונקציה לעדכון הסטטוס והפרוגרס בר ---
function updateStatus(text, progressValue = null) {
    statusDiv.textContent = text;
    if (progressValue !== null && progressValue >= 0 && progressValue <= 100) {
        progressBar.style.display = 'block';
        progressBar.value = progressValue;
    } else {
        progressBar.style.display = 'none';
    }
}

// --- פונקציית חילוץ והמרת אודיו (ללא שינוי מהגרסה הקודמת) ---
async function extractAndResampleAudio(mediaFile) {
    updateStatus('קורא קובץ מדיה...', 0);
    let audioContext;
    try {
        audioContext = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE });
        if (audioContext.state === 'suspended') {
            await audioContext.resume();
        }
    } catch (e) {
        console.error("Failed to create/resume AudioContext:", e);
        return Promise.reject(`שגיאה ביצירת הקשר אודיו: ${e.message}. נסה לרענן או ללחוץ על הדף.`);
    }

    const fileReader = new FileReader();

    return new Promise((resolve, reject) => {
        fileReader.onprogress = (event) => {
            if (event.lengthComputable) {
                const percentComplete = (event.loaded / event.total) * 100;
                updateStatus(`קורא קובץ מדיה... (${Math.round(percentComplete)}%)`, percentComplete);
            }
        };

        fileReader.onload = async (event) => {
            try {
                updateStatus('מפענח אודיו...', null);
                const audioBuffer = await audioContext.decodeAudioData(event.target.result);

                if (audioBuffer.length === 0) {
                    reject("קובץ האודיו ריק.");
                    return;
                }

                if (audioBuffer.sampleRate !== TARGET_SAMPLE_RATE) {
                    console.warn(`קצב דגימה מקורי: ${audioBuffer.sampleRate}, ממיר ל-${TARGET_SAMPLE_RATE}`);
                    updateStatus(`ממיר קצב דגימה ל-${TARGET_SAMPLE_RATE}Hz...`, null);
                    const offlineContext = new OfflineAudioContext(
                        audioBuffer.numberOfChannels,
                        audioBuffer.duration * TARGET_SAMPLE_RATE,
                        TARGET_SAMPLE_RATE
                    );
                    const source = offlineContext.createBufferSource();
                    source.buffer = audioBuffer;
                    source.connect(offlineContext.destination);
                    source.start();
                    const resampledBuffer = await offlineContext.startRendering();
                    resolve(convertToMono(resampledBuffer));
                } else {
                    resolve(convertToMono(audioBuffer));
                }
            } catch (error) {
                console.error("שגיאה בפענוח אודיו:", error);
                reject(`שגיאה בפענוח האודיו: ${error.message}. בדוק אם הפורמט נתמך.`);
            } finally {
                 if (audioContext && audioContext.state !== 'closed') {
                    audioContext.close().catch(console.error);
                 }
            }
        };
        fileReader.onerror = (error) => {
            if (audioContext && audioContext.state !== 'closed') {
                audioContext.close().catch(console.error);
            }
            reject(`שגיאה בקריאת הקובץ: ${error}`);
        }
        fileReader.readAsArrayBuffer(mediaFile);
    });
}

// פונקציית עזר להמרת AudioBuffer למונו (ללא שינוי)
function convertToMono(audioBuffer) {
    if (audioBuffer.numberOfChannels === 1) {
        return audioBuffer.getChannelData(0);
    } else {
        console.log(`Converting ${audioBuffer.numberOfChannels} channels to mono.`);
        const numChannels = audioBuffer.numberOfChannels;
        const numSamples = audioBuffer.length;
        const monoChannel = new Float32Array(numSamples);
        for (let i = 0; i < numSamples; ++i) {
            let sampleSum = 0;
            for (let j = 0; j < numChannels; ++j) {
                sampleSum += audioBuffer.getChannelData(j)[i];
            }
            monoChannel[i] = sampleSum / numChannels;
        }
        return monoChannel;
    }
}

// --- פונקציה להמרת תוצאות התמלול לפורמט SRT (ללא שינוי) ---
function formatTimeToSRT(seconds) {
     if (isNaN(seconds) || seconds === null || seconds < 0) return '00:00:00,000';
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    const ms = Math.floor((seconds - Math.floor(seconds)) * 1000);
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

function chunksToSRT(chunks) {
    let srtContent = '';
    let itemIndex = 1;
    chunks.forEach((chunk) => {
        if (chunk.timestamp &&
            typeof chunk.timestamp[0] === 'number' && !isNaN(chunk.timestamp[0]) &&
            typeof chunk.timestamp[1] === 'number' && !isNaN(chunk.timestamp[1]) &&
            chunk.timestamp[0] <= chunk.timestamp[1] &&
            chunk.text && chunk.text.trim().length > 0)
        {
            const startTime = formatTimeToSRT(chunk.timestamp[0]);
            const endTime = formatTimeToSRT(chunk.timestamp[1]);
            srtContent += `${itemIndex}\n`;
            srtContent += `${startTime} --> ${endTime}\n`;
            srtContent += `${chunk.text.trim()}\n\n`;
            itemIndex++;
        } else {
            console.warn("Chunk skipped due to invalid timestamp or empty text:", chunk);
        }
    });
    return srtContent;
}

// *** פונקציה חדשה: יצירת תוכן TXT ***
function createTxtContent(output) {
    if (!output) return ''; // אין פלט כלל
    if (output.chunks && output.chunks.length > 0) {
        // חלץ טקסט ממקטעים תקינים
        return output.chunks
            .filter(chunk => chunk.text && chunk.text.trim().length > 0)
            .map(chunk => chunk.text.trim())
            .join('\n'); // חבר עם שורות חדשות
    } else if (output.text && output.text.trim().length > 0) {
        // השתמש בטקסט הכללי אם אין מקטעים
        return output.text.trim();
    }
    return ''; // החזר מחרוזת ריקה אם אין טקסט
}


// --- פונקציה לטיפול בהורדת המודל והתקדמות התמלול (כולל התיקון ל-download) ---
function modelProgressCallback(data) {
    const status = data.status;
    console.log("Model Progress Raw:", data);

    switch (status) {
        case 'initiate':
            updateStatus(`מאתחל הורדת קובץ מודל: ${data.file}`, 0);
            break;
        case 'download':
             updateStatus(`מתחיל הורדת קובץ מודל: ${data.file}...`, 0);
             break;
        case 'downloading':
            const progress = data.progress?.toFixed(2) || 0;
            updateStatus(`מוריד קובץ מודל: ${data.file} (${progress}%)`, progress);
            break;
        case 'progress':
            const transcriptionProgress = data.progress?.toFixed(2) || 0;
             if (data.file) {
                  updateStatus(`מעבד קובץ מודל: ${data.file} (${transcriptionProgress}%)`, transcriptionProgress);
             } else {
                  updateStatus(`מתמלל... (${transcriptionProgress}%)`, transcriptionProgress);
             }
            break;
        case 'done':
             if (data.file) {
                updateStatus(`הורדת/טעינת ${data.file} הושלמה.`, null);
             }
            break;
        case 'ready':
            updateStatus('מודל התמלול מוכן.', null);
            break;
        default:
             console.log(`סטטוס מודל לא מוכר: ${status}`, data);
    }
}

// --- אתחול ה-pipeline (ללא שינוי) ---
let transcriber = null;
let isModelLoading = true;
updateStatus('טוען מודל שפה... (ייתכן וייקח זמן בפעם הראשונה)', 0);

pipeline('automatic-speech-recognition', MODEL_NAME, {
    progress_callback: modelProgressCallback,
}).then(loadedPipeline => {
    transcriber = loadedPipeline;
    isModelLoading = false;
    updateStatus('המודל נטען. אנא בחר קובץ וידאו או אודיו.', null);
    videoFileInput.disabled = false;
    languageSelect.disabled = false;
}).catch(error => {
    console.error("שגיאה קריטית בטעינת המודל:", error);
    updateStatus(`שגיאה חמורה בטעינת מודל השפה: ${error.message}. נסה לרענן את הדף.`, null);
    isModelLoading = false;
});

// נטרול ראשוני של הפקדים
videoFileInput.disabled = true;
languageSelect.disabled = true;

// --- הלוגיקה המרכזית - בעת בחירת קובץ ---
videoFileInput.addEventListener('change', async (event) => {
    const file = event.target.files[0];
    if (!file) return;

    if (!transcriber) {
        if (isModelLoading) {
            updateStatus("המודל עדיין בטעינה, אנא המתן...", null);
        } else {
            updateStatus("טעינת המודל נכשלה. רענן את הדף ונסה שוב.", null);
        }
        return;
    }

    // השבת פקדים והסתר קישורים קודמים
    videoFileInput.disabled = true;
    languageSelect.disabled = true;
    // *** שינוי: הסתר את שני הקישורים ***
    downloadLinkSrt.style.display = 'none';
    downloadLinkTxt.style.display = 'none';
    downloadButtonsDiv.style.display = 'none'; // הסתר גם את ה-div העוטף
    updateStatus('מתחיל עיבוד קובץ...', 0);

    // משתנים לאחסון כתובות ה-URL לשחרור מאוחר יותר
    let srtUrlToRevoke = null;
    let txtUrlToRevoke = null;

    try {
        // 1. חילוץ והמרת אודיו
        const audioData = await extractAndResampleAudio(file);

        // בדיקות ניפוי שגיאות לאודיו
        console.log('Audio Data:', audioData);
        console.log('Audio Data Type:', Object.prototype.toString.call(audioData));
        console.log('Audio Data Length:', audioData?.length);
        const isSilent = audioData?.every(sample => sample === 0);
        console.log('Is Audio Silent?', isSilent);
        const hasInvalidValues = !audioData?.every(Number.isFinite);
        console.log('Has Invalid Values (NaN/Infinity)?', hasInvalidValues);

        if (!audioData || audioData.length === 0) throw new Error("נתוני האודיו ריקים אחרי החילוץ וההמרה.");
        if (hasInvalidValues) throw new Error("נתוני האודיו מכילים ערכים לא תקינים (NaN/Infinity).");
        if (isSilent) console.warn("נתוני האודיו שקטים לחלוטין.");

        // קבל את השפה שנבחרה
        let selectedLanguage = languageSelect.value;
        if (selectedLanguage === 'auto') {
            selectedLanguage = undefined;
            updateStatus('מתמלל (זיהוי שפה אוטומטי)...', null);
        } else {
             updateStatus(`מתמלל (שפה: ${selectedLanguage})...`, null);
        }

        // 2. הפעלת התמלול
        const output = await transcriber(audioData, {
            chunk_length_s: 30,
            stride_length_s: 5,
            language: selectedLanguage,
            task: TASK,
            return_timestamps: true,
        });

        console.log("Transcription Output:", output);
        updateStatus('מעבד תוצאות ויוצר קבצים להורדה...', null);

        // 3. יצירת תוכן SRT
        let srtContent = '';
        if (output && output.chunks && output.chunks.length > 0) {
            srtContent = chunksToSRT(output.chunks);
        } else if (output && output.text && output.text.trim().length > 0) {
            console.warn("יוצר SRT עם טקסט כללי.");
            const duration = audioData.length / TARGET_SAMPLE_RATE;
            const fakeChunk = { timestamp: [0, duration || 1], text: output.text };
            srtContent = chunksToSRT([fakeChunk]);
        }
        if (!srtContent) {
             throw new Error("יצירת תוכן SRT נכשלה (לא נמצאו מקטעים תקינים).");
        }

        // *** 4. יצירת תוכן TXT ***
        const txtContent = createTxtContent(output);
        if (!txtContent) {
             // זה פחות קריטי, אפשר רק לתת אזהרה ולאפשר הורדת SRT
             console.warn("יצירת תוכן TXT נכשלה (לא נמצא טקסט).");
        }

        // 5. יצירת קישורים להורדה
        const originalFileName = file.name.substring(0, file.name.lastIndexOf('.')) || 'subtitles';

        // יצירת קישור SRT
        const blobSrt = new Blob([srtContent], { type: 'text/srt;charset=utf-8' });
        srtUrlToRevoke = URL.createObjectURL(blobSrt); // שמור לשחרור
        downloadLinkSrt.href = srtUrlToRevoke;
        downloadLinkSrt.download = `${originalFileName}.srt`;
        downloadLinkSrt.style.display = 'inline-block'; // הצג

        // יצירת קישור TXT (רק אם יש תוכן)
        if (txtContent) {
            const blobTxt = new Blob([txtContent], { type: 'text/plain;charset=utf-8' });
            txtUrlToRevoke = URL.createObjectURL(blobTxt); // שמור לשחרור
            downloadLinkTxt.href = txtUrlToRevoke;
            downloadLinkTxt.download = `${originalFileName}.txt`;
            downloadLinkTxt.style.display = 'inline-block'; // הצג
        } else {
             downloadLinkTxt.style.display = 'none'; // השאר מוסתר אם אין תוכן TXT
        }
        downloadButtonsDiv.style.display = 'block'; // הצג את ה-div העוטף

        updateStatus('התמלול הושלם! לחץ על הקישור הרצוי להורדה.', null);

    } catch (error) {
        console.error("שגיאה בתהליך התמלול:", error);
        statusDiv.textContent = `אירעה שגיאה: ${error.message}`;
        progressBar.style.display = 'none';
        downloadLinkSrt.style.display = 'none'; // הסתר קישורים במקרה שגיאה
        downloadLinkTxt.style.display = 'none';
        downloadButtonsDiv.style.display = 'none';

        // נסה לשחרר URLs אם נוצרו לפני השגיאה
        if (srtUrlToRevoke) URL.revokeObjectURL(srtUrlToRevoke);
        if (txtUrlToRevoke) URL.revokeObjectURL(txtUrlToRevoke);

    } finally {
        // אפשר פקדים מחדש
        if (!isModelLoading) {
             videoFileInput.disabled = false;
             languageSelect.disabled = false;
        }
         videoFileInput.value = '';

         // שחרור כתובות ה-URL לאחר זמן (רק אם לא שוחררו כבר ב-catch)
         if (srtUrlToRevoke && !error) { // בדוק אם המשתנה קיים והאם לא הייתה שגיאה
            setTimeout(() => {
                console.log('Revoking SRT blob URL');
                URL.revokeObjectURL(srtUrlToRevoke);
            }, 180000);
         }
         if (txtUrlToRevoke && !error) { // בדוק אם המשתנה קיים והאם לא הייתה שגיאה
            setTimeout(() => {
                console.log('Revoking TXT blob URL');
                URL.revokeObjectURL(txtUrlToRevoke);
            }, 180000);
         }
    }
});