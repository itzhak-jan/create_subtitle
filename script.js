// --- ייבוא מהספרייה ---
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.1';

// הגדרות סביבה
env.allowLocalModels = false;
env.allowRemoteModels = true;

// --- קבלת רפרנסים לאלמנטים ב-HTML ---
const videoFileInput = document.getElementById('videoFile');
const statusDiv = document.getElementById('status');
const downloadLink = document.getElementById('downloadLink');
const progressBar = document.getElementById('progressBar');
const languageSelect = document.getElementById('languageSelect');
// *** רפרנס לאלמנט החדש ***
const progressDetailDiv = document.getElementById('progressDetail');

// --- הגדרות תמלול ---
const MODEL_NAME = 'Xenova/whisper-tiny';
const TARGET_SAMPLE_RATE = 16000;
const TASK = 'transcribe';

// --- פונקציה לעדכון הסטטוס והפרוגרס בר ---
// (נשאיר אותה לעדכון הראשי, את הפירוט נעדכן מהקולבק)
function updateStatus(text, progressValue = null) {
    statusDiv.textContent = text;
    if (progressValue !== null && progressValue >= 0 && progressValue <= 100) {
        progressBar.style.display = 'block';
        progressBar.value = progressValue;
    } else {
        progressBar.style.display = 'none';
    }
    // נקה את הפירוט כשהסטטוס הראשי מתעדכן (אלא אם זה עדכון התקדמות)
    if (progressValue === null) {
        progressDetailDiv.textContent = '';
    }
}

// --- פונקציית חילוץ והמרת אודיו (עם החזרת משך) ---
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
        throw new Error(`שגיאה ביצירת הקשר אודיו: ${e.message}. נסה לרענן או ללחוץ על הדף.`);
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

                // *** שמירת משך האודיו ***
                const duration = audioBuffer.duration;
                console.log(`Audio duration: ${duration} seconds`);

                let monoAudioData;
                if (audioBuffer.sampleRate !== TARGET_SAMPLE_RATE) {
                    console.warn(`קצב דגימה מקורי: ${audioBuffer.sampleRate}, ממיר ל-${TARGET_SAMPLE_RATE}`);
                    updateStatus(`ממיר קצב דגימה ל-${TARGET_SAMPLE_RATE}Hz...`, null);
                    const offlineContext = new OfflineAudioContext(
                        audioBuffer.numberOfChannels,
                        duration * TARGET_SAMPLE_RATE, // השתמש במשך המחושב
                        TARGET_SAMPLE_RATE
                    );
                    const source = offlineContext.createBufferSource();
                    source.buffer = audioBuffer;
                    source.connect(offlineContext.destination);
                    source.start();
                    const resampledBuffer = await offlineContext.startRendering();
                    monoAudioData = convertToMono(resampledBuffer);
                } else {
                    monoAudioData = convertToMono(audioBuffer);
                }

                // *** החזרת אובייקט עם האודיו והמשך ***
                resolve({ data: monoAudioData, duration: duration });

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
    // ... (קוד זהה לקודם)
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
    // ... (קוד זהה לקודם)
    if (isNaN(seconds) || seconds === null || seconds < 0) return '00:00:00,000';
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    const ms = Math.floor((seconds - Math.floor(seconds)) * 1000);
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

function chunksToSRT(chunks) {
    // ... (קוד זהה לקודם)
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

// --- Callback נפרד לטעינת המודל (פעם אחת) ---
function modelLoadingProgressCallback(data) {
    const status = data.status;
    console.log("Model Loading Progress Raw:", data); // לוג גולמי לניפוי באגים

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
        case 'progress': // התקדמות טעינה/הכנה של קובץ שכבר הורד
             const loadingProgress = data.progress?.toFixed(2) || 0;
             if (data.file) {
                  updateStatus(`מעבד קובץ מודל: ${data.file} (${loadingProgress}%)`, loadingProgress);
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
             console.log(`סטטוס טעינת מודל לא מוכר: ${status}`, data);
    }
}

// --- אתחול ה-pipeline (כמו קודם) ---
let transcriber = null;
let isModelLoading = true;
updateStatus('טוען מודל שפה... (ייתכן וייקח זמן בפעם הראשונה)', 0);

pipeline('automatic-speech-recognition', MODEL_NAME, {
    progress_callback: modelLoadingProgressCallback, // קולבק רק לטעינה
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
        updateStatus(isModelLoading ? "המודל עדיין בטעינה, אנא המתן..." : "טעינת המודל נכשלה. רענן את הדף ונסה שוב.", null);
        return;
    }

    videoFileInput.disabled = true;
    languageSelect.disabled = true;
    downloadLink.style.display = 'none';
    progressDetailDiv.textContent = ''; // נקה פירוט קודם
    updateStatus('מתחיל עיבוד קובץ...', 0);

    let audioInfo; // *** להחזיק את המידע על האודיו ***

    try {
        // 1. חילוץ והמרת אודיו
        audioInfo = await extractAndResampleAudio(file); // מקבלים { data, duration }
        const audioData = audioInfo.data; // נתוני האודיו עצמם
        const totalAudioDuration = audioInfo.duration; // משך האודיו הכולל

        // --- בדיקות ניפוי שגיאות לאודיו ---
        console.log('Audio Data Type:', Object.prototype.toString.call(audioData));
        console.log('Audio Data Length:', audioData?.length);
        const isSilent = audioData?.every(sample => sample === 0);
        console.log('Is Audio Silent?', isSilent);
        const hasInvalidValues = !audioData?.every(Number.isFinite);
        console.log('Has Invalid Values (NaN/Infinity)?', hasInvalidValues);
        // ניתן להדפיס רק חלק קטן מהמערך לבדיקה
        console.log('Audio Data (first 10 samples):', audioData?.slice(0, 10));


        if (!audioData || audioData.length === 0) throw new Error("נתוני האודיו ריקים אחרי החילוץ וההמרה.");
        if (hasInvalidValues) throw new Error("נתוני האודיו מכילים ערכים לא תקינים (NaN/Infinity).");
        if (isSilent) console.warn("נתוני האודיו שקטים לחלוטין.");
        // -----------------------------------------

        let selectedLanguage = languageSelect.value;
        if (selectedLanguage === 'auto') selectedLanguage = undefined;

        updateStatus(selectedLanguage ? `מתמלל (שפה: ${selectedLanguage})...` : 'מתמלל (זיהוי שפה אוטומטי)...', 0); // אתחל פרוגרס

        // *** קולבק פנימי להתקדמות התמלול ***
        const transcriptionProgressCallback = (data) => {
            console.log("Transcription Progress Raw:", data);
            if (data.status === 'progress' && !data.file) { // לוודא שזה התקדמות תמלול
                 const transcriptionProgress = data.progress?.toFixed(2) || 0;
                 // חישוב זמן מוערך
                 const estimatedSeconds = totalAudioDuration * (transcriptionProgress / 100);
                 const formattedTime = formatTimeToSRT(estimatedSeconds);
                 const totalFormattedTime = formatTimeToSRT(totalAudioDuration); // משך כולל

                 updateStatus(`מתמלל... (${transcriptionProgress}%)`, transcriptionProgress);
                 // עדכון הפירוט
                 progressDetailDiv.textContent = `מעבד סביב זמן: ${formattedTime} / ${totalFormattedTime}`;
            } else if (data.status === 'update' && data.text) {
                // חלק מה-pipelines מחזירים עדכוני טקסט חלקיים, נציג אותם
                progressDetailDiv.textContent = `טקסט חלקי: ${data.text}`;
            }
        };


        // 2. הפעלת התמלול *** עם הקולבק הפנימי ***
        const output = await transcriber(audioData, {
            chunk_length_s: 30,
            stride_length_s: 5,
            language: selectedLanguage,
            task: TASK,
            return_timestamps: true,
            progress_callback: transcriptionProgressCallback, // העברת הקולבק
        });

        console.log("Transcription Output:", output);
        updateStatus('מעבד תוצאות ויוצר קובץ SRT...', null); // הסתר פרוגרס בר ראשי
        progressDetailDiv.textContent = ''; // נקה פירוט סופי

        // 3. פורמט ל-SRT (כמו קודם, עם המשתנה srtContent מוגדר בחוץ)
        let srtContent = '';
        if (!output || (!output.chunks || output.chunks.length === 0)) {
            if (output && output.text && output.text.trim().length > 0) {
                console.warn("התמלול לא החזיר chunks עם חותמות זמן, יוצר SRT עם טקסט כללי.");
                const duration = totalAudioDuration; // שימוש במשך המדויק
                const fakeChunk = { timestamp: [0, duration || 1], text: output.text };
                srtContent = chunksToSRT([fakeChunk]);
                if (!srtContent) throw new Error("יצירת תוכן SRT נכשלה גם מטקסט כללי.");
            } else {
                throw new Error("התמלול לא החזיר תוצאות (לא chunks ולא טקסט). ייתכן והקובץ שקט או שהשפה לא זוהתה.");
            }
        } else {
            srtContent = chunksToSRT(output.chunks);
            if (!srtContent) {
                throw new Error("יצירת תוכן SRT נכשלה (לא נמצאו chunks תקינים עם חותמות זמן וטקסט).");
            }
        }

        // 4. יצירת קישור להורדה
        const blob = new Blob([srtContent], { type: 'text/srt;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        downloadLink.href = url;
        const originalFileName = file.name.substring(0, file.name.lastIndexOf('.')) || 'subtitles';
        downloadLink.download = `${originalFileName}.srt`;
        downloadLink.style.display = 'inline-block';
        updateStatus('התמלול הושלם! לחץ על הקישור להורדה.', null);

        setTimeout(() => {
            console.log('Revoking blob URL');
            URL.revokeObjectURL(url);
        }, 180000);

    } catch (error) {
        console.error("שגיאה בתהליך התמלול:", error);
        statusDiv.textContent = `אירעה שגיאה: ${error.message}`;
        progressBar.style.display = 'none';
        progressDetailDiv.textContent = ''; // נקה פירוט בשגיאה
        downloadLink.style.display = 'none';
    } finally {
        if (!isModelLoading) {
             videoFileInput.disabled = false;
             languageSelect.disabled = false;
        }
         videoFileInput.value = '';
    }
});