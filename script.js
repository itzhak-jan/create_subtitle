// script.js (Vanilla JS - טעינה מאוחרת)

// --- ייבוא מהספרייה (ודא שהקישור ל-CDN נכון) ---
// השתמש בקישור שכולל את /dist/transformers.min.js כדי למנוע שגיאות import
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.1/dist/transformers.min.js';

// הגדרות סביבה
env.allowLocalModels = false;
env.allowRemoteModels = true;

// --- קבלת רפרנסים לאלמנטים ב-HTML ---
const videoFileInput = document.getElementById('videoFile');
const languageSelect = document.getElementById('languageSelect');
const startButton = document.getElementById('startButton');
const statusDiv = document.getElementById('status');
const progressBar = document.getElementById('progressBar');
const progressDetailDiv = document.getElementById('progressDetail');
const downloadButtonsDiv = document.getElementById('downloadButtons');
const downloadLinkSrt = document.getElementById('downloadLinkSrt');
const downloadLinkTxt = document.getElementById('downloadLinkTxt');
const copySrtButton = document.getElementById('copySrtButton');
const copySrtButtonPlaceholder = document.getElementById('copySrtButtonPlaceholder');
const copyPromptButton = document.getElementById('copyPromptButton');

// --- משתנים גלובליים ---
const MODEL_NAME = 'Xenova/whisper-tiny';
const TARGET_SAMPLE_RATE = 16000;
const TASK = 'transcribe';
let transcriber = null; // *** שינוי: מתחיל כ-null ***
let isModelLoading = false; // *** שינוי: נוסיף דגל טעינה ***
let selectedFile = null;
let currentSrtContent = '';
let sharedBlobUrlToRevoke = null;

// --- פונקציות עזר (ללא שינוי: updateStatus, extractAndResampleAudio, convertToMono, formatTimeToSRT, chunksToSRT) ---

function updateStatus(text, progressValue = null, detailText = '') {
    statusDiv.textContent = text;
    progressDetailDiv.textContent = detailText;
    if (progressValue !== null && progressValue >= 0 && progressValue <= 100) {
        progressBar.style.display = 'block';
        progressBar.value = progressValue;
    } else {
        progressBar.style.display = 'none';
    }
}

async function extractAndResampleAudio(mediaFile) {
    updateStatus('קורא קובץ מדיה...', 0, 'מתחיל...');
    let audioContext;
    try {
        audioContext = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE });
        if (audioContext.state === 'suspended') {
            console.log("AudioContext suspended, attempting to resume...");
            await audioContext.resume(); // Try to resume - might require user interaction
        }
    } catch (e) {
        console.error("Failed to create/resume AudioContext:", e);
        throw new Error(`שגיאה ביצירת הקשר אודיו: ${e.message}. נסה ללחוץ על הדף.`);
    }

    const fileReader = new FileReader();

    return new Promise((resolve, reject) => {
        fileReader.onprogress = (event) => {
            if (event.lengthComputable) {
                const percentComplete = (event.loaded / event.total) * 100;
                updateStatus(`קורא קובץ מדיה... (${Math.round(percentComplete)}%)`, percentComplete, `הורדו ${Math.round(event.loaded / 1024 / 1024)}MB מתוך ${Math.round(event.total / 1024 / 1024)}MB`);
            }
        };

        fileReader.onload = async (event) => {
            try {
                updateStatus('מפענח אודיו...', null, 'מעבד נתוני שמע גולמיים...');
                if (!event.target || !event.target.result) {
                     throw new Error("קריאת הקובץ לא החזירה נתונים.");
                }
                const audioBuffer = await audioContext.decodeAudioData(event.target.result);

                if (audioBuffer.length === 0) {
                    throw new Error("קובץ האודיו ריק.");
                }

                let processedBuffer;
                if (audioBuffer.sampleRate !== TARGET_SAMPLE_RATE) {
                    console.warn(`קצב דגימה מקורי: ${audioBuffer.sampleRate}, ממיר ל-${TARGET_SAMPLE_RATE}`);
                    updateStatus(`ממיר קצב דגימה ל-${TARGET_SAMPLE_RATE}Hz...`, null, 'מבצע Resampling...');
                    const offlineContext = new OfflineAudioContext(
                        audioBuffer.numberOfChannels,
                        audioBuffer.duration * TARGET_SAMPLE_RATE,
                        TARGET_SAMPLE_RATE
                    );
                    const source = offlineContext.createBufferSource();
                    source.buffer = audioBuffer;
                    source.connect(offlineContext.destination);
                    source.start();
                    processedBuffer = await offlineContext.startRendering();
                } else {
                    processedBuffer = audioBuffer;
                }
                 updateStatus('ממיר למונו (אם נדרש)...', null, 'מכין ערוץ אודיו יחיד...');
                resolve(convertToMono(processedBuffer));

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


function convertToMono(audioBuffer) {
    if (audioBuffer.numberOfChannels === 1) {
        return audioBuffer.getChannelData(0);
    }
    console.log(`Converting ${audioBuffer.numberOfChannels} channels to mono.`);
    const numChannels = audioBuffer.numberOfChannels;
    const numSamples = audioBuffer.length;
    const monoChannel = new Float32Array(numSamples);
    for (let i = 0; i < numSamples; ++i) {
        let sampleSum = 0;
        for (let j = 0; j < numChannels; ++j) { sampleSum += audioBuffer.getChannelData(j)[i]; }
        monoChannel[i] = sampleSum / numChannels;
    }
    return monoChannel;
}

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
        if (chunk.timestamp && typeof chunk.timestamp[0] === 'number' && !isNaN(chunk.timestamp[0]) && typeof chunk.timestamp[1] === 'number' && !isNaN(chunk.timestamp[1]) && chunk.timestamp[0] <= chunk.timestamp[1] && chunk.text && chunk.text.trim().length > 0) {
            const startTime = formatTimeToSRT(chunk.timestamp[0]);
            const endTime = formatTimeToSRT(chunk.timestamp[1]);
            srtContent += `${itemIndex}\n`; srtContent += `${startTime} --> ${endTime}\n`; srtContent += `${chunk.text.trim()}\n\n`; itemIndex++;
        } else { console.warn("Skipped chunk:", chunk); }
    });
    return srtContent;
}


// --- Model Progress Callback ---
function modelProgressCallback(data) {
    const status = data.status;
    const file = data.file || '';
    const progress = data.progress?.toFixed(1) || 0;
    let detailText = '';
    console.log("Model Progress Raw:", data);

    switch (status) {
        case 'initiate': detailText = `מתחיל הורדה: ${file}`; updateStatus('טוען מודל...', 0, detailText); break;
        case 'download': detailText = `מוריד: ${file}`; updateStatus('טוען מודל...', 0, detailText); break;
        case 'downloading':
            detailText = `מוריד: ${file} (${progress}%)`;
            if (data.loaded && data.total) { detailText += ` - ${Math.round(data.loaded/1e6)}MB / ${Math.round(data.total/1e6)}MB`; }
            updateStatus('טוען מודל...', progress, detailText); break;
        case 'progress': if (file) { detailText = `מעבד קובץ: ${file} (${progress}%)`; updateStatus('טוען מודל...', progress, detailText); } break; // Only show progress for model files
        case 'done': if (file) { updateStatus('טוען מודל...', 100, `הושלם: ${file}`); } break;
        case 'ready': updateStatus('המודל מוכן.', null, ''); break; // Final ready state
        default: console.log(`סטטוס מודל לא מוכר: ${status}`, data);
    }
}

// --- פונקציית טעינת המודל (נקראת רק אם transcriber הוא null) ---
async function loadTranscriptionModel() {
    if (transcriber) return transcriber; // כבר טעון
    if (isModelLoading) return null; // כבר בתהליך טעינה

    isModelLoading = true;
    videoFileInput.disabled = true;
    languageSelect.disabled = true;
    startButton.disabled = true;
    updateStatus('טוען מודל שפה...', 0, 'הורדה ראשונית עשויה לקחת זמן...');

    try {
        console.log("Attempting to load pipeline...");
        const loadedPipeline = await pipeline('automatic-speech-recognition', MODEL_NAME, {
            progress_callback: modelProgressCallback,
        });
        transcriber = loadedPipeline; // שמור את ה-pipeline הטעון
        isModelLoading = false;
        console.log("Pipeline loaded successfully.");
        updateStatus('המודל נטען. התמלול יתחיל מיד.', null, ''); // עדכן סטטוס
        // אפשר פקדים רלוונטיים אם צריך, אבל התמלול מתחיל מיד
        return transcriber;
    } catch (error) {
        console.error("שגיאה קריטית בטעינת המודל:", error);
        updateStatus(`שגיאה חמורה בטעינת מודל השפה: ${error.message}. נסה לרענן.`, null, '');
        isModelLoading = false;
        transcriber = null; // אפס במקרה שגיאה
        // השאר פקדים מנוטרלים כי אי אפשר להמשיך
        videoFileInput.disabled = true;
        languageSelect.disabled = true;
        startButton.disabled = true;
        return null; // החזר null לציון כשל
    }
}

// --- אתחול ראשוני (רק הגדרת מאזינים, לא טוען מודל) ---
videoFileInput.disabled = false; // אפשר בחירת קובץ
languageSelect.disabled = false; // אפשר בחירת שפה
startButton.disabled = true; // התחל מנוטרל
updateStatus('אנא בחר קובץ ובחר שפה.', null, '');


// --- אירועים ---

videoFileInput.addEventListener('change', (event) => {
    selectedFile = event.target.files[0];
    if (selectedFile) {
        startButton.disabled = false; // אפשר את כפתור ההתחלה
        updateStatus('קובץ נבחר. לחץ "התחל תמלול".', null, '');
        downloadButtonsDiv.style.display = 'none';
        copySrtButton.style.display = 'none';
        copySrtButtonPlaceholder.style.display = 'none';
        if (sharedBlobUrlToRevoke) { URL.revokeObjectURL(sharedBlobUrlToRevoke); sharedBlobUrlToRevoke = null; }
    } else {
        startButton.disabled = true;
        updateStatus('אנא בחר קובץ.', null, '');
    }
});

startButton.addEventListener('click', async () => {
    if (!selectedFile) { updateStatus("שגיאה: לא נבחר קובץ.", null, ''); return; }

    // השבת פקדים לפני שמתחילים
    videoFileInput.disabled = true;
    languageSelect.disabled = true;
    startButton.disabled = true;
    downloadButtonsDiv.style.display = 'none';
    copySrtButton.style.display = 'none';
    copySrtButtonPlaceholder.style.display = 'none';
    updateStatus('מתחיל...', 0, '');
    currentSrtContent = '';
    if (sharedBlobUrlToRevoke) { URL.revokeObjectURL(sharedBlobUrlToRevoke); sharedBlobUrlToRevoke = null; }

    try {
        // *** שלב 1: טען את המודל (רק אם עדיין לא טעון) ***
        const currentTranscriber = await loadTranscriptionModel();
        if (!currentTranscriber) {
             // הודעת שגיאה כבר הוצגה בתוך loadTranscriptionModel
             return;
        }

        // *** שלב 2: חילוץ אודיו ***
        updateStatus('מעבד קובץ אודיו...', 0, 'קורא ומפענח...');
        const audioData = await extractAndResampleAudio(selectedFile);
        // בדיקות תקינות לאודיו
        console.log('Audio Data Length:', audioData?.length);
        if (!audioData || audioData.length === 0) throw new Error("נתוני האודיו ריקים.");
        const hasInvalidValues = !audioData.every(Number.isFinite);
        if (hasInvalidValues) throw new Error("נתוני האודיו פגומים.");

        // *** שלב 3: הפעלת התמלול ***
        let selectedLanguageOption = languageSelect.value;
        let langForWhisper = selectedLanguageOption === 'auto' ? undefined : selectedLanguageOption;
        updateStatus(`מתמלל (שפה: ${langForWhisper || 'אוטומטי'})...`, null, 'זה עלול לקחת זמן...');

        // *** הוספת setTimeout קטן כדי לתת ל-UI להתעדכן ***
        await new Promise(resolve => setTimeout(resolve, 50));

        const output = await currentTranscriber(audioData, {
            chunk_length_s: 30,
            stride_length_s: 5,
            language: langForWhisper,
            task: TASK,
            return_timestamps: true,
             // ה-callback כאן אולי פחות יעיל ב-Vanilla JS בלי worker,
             // כי ה-thread הראשי יהיה תפוס. נשאיר למקרה שכן מגיע משהו.
            progress_callback: (p) => {
                if (p.status === 'progress' && !p.file) {
                    updateStatus(`מתמלל (${p.progress?.toFixed(1)}%)...`, p.progress, 'מעבד מקטע...');
                }
            }
        });

        console.log("Transcription Output:", output);
        updateStatus('מעבד תוצאות...', null, 'יוצר קבצים להורדה...');

        // *** שלב 4: יצירת קבצים וקישורים ***
        let generatedSrtContent = '';
        if (output?.chunks?.length) generatedSrtContent = chunksToSRT(output.chunks);
        else if (output?.text) { const duration = audioData.length / TARGET_SAMPLE_RATE; const fakeChunk = { timestamp: [0, duration || 1], text: output.text }; generatedSrtContent = chunksToSRT([fakeChunk]); }
        if (!generatedSrtContent) throw new Error("יצירת SRT נכשלה.");

        currentSrtContent = generatedSrtContent;
        const originalFileName = selectedFile.name.substring(0, selectedFile.name.lastIndexOf('.')) || 'subtitles';
        const blobContent = new Blob([currentSrtContent], { type: 'text/plain;charset=utf-8' });
        sharedBlobUrlToRevoke = URL.createObjectURL(blobContent);

        downloadLinkSrt.href = sharedBlobUrlToRevoke;
        downloadLinkSrt.download = `${originalFileName}.srt`;
        downloadLinkSrt.style.display = 'inline-block';
        downloadLinkTxt.href = sharedBlobUrlToRevoke;
        downloadLinkTxt.download = `${originalFileName}.txt`;
        downloadLinkTxt.style.display = 'inline-block';
        copySrtButton.style.display = 'inline-block';
        copySrtButtonPlaceholder.style.display = 'inline-block';
        downloadButtonsDiv.style.display = 'block';

        updateStatus('התמלול הושלם!', null, '');

    } catch (error) {
        console.error("שגיאה בתהליך:", error);
        statusDiv.textContent = `אירעה שגיאה: ${error.message}`;
        progressBar.style.display = 'none'; progressDetailDiv.textContent = '';
        downloadButtonsDiv.style.display = 'none'; copySrtButton.style.display = 'none'; copySrtButtonPlaceholder.style.display = 'none';
        currentSrtContent = '';
        if (sharedBlobUrlToRevoke) { URL.revokeObjectURL(sharedBlobUrlToRevoke); sharedBlobUrlToRevoke = null; }

    } finally {
        // אפשר פקדים מחדש רק אם המודל נטען בהצלחה
        if (transcriber) {
             videoFileInput.disabled = false;
             languageSelect.disabled = false;
             startButton.disabled = !selectedFile; // אפשר שוב אם יש קובץ
        } else {
            // השאר מנוטרל אם הייתה שגיאה בטעינת המודל
            videoFileInput.disabled = true;
            languageSelect.disabled = true;
            startButton.disabled = true;
        }

        // שחרור URL מאוחר יותר
        if (sharedBlobUrlToRevoke) {
            setTimeout(() => {
                if (sharedBlobUrlToRevoke) { console.log('Revoking URL'); URL.revokeObjectURL(sharedBlobUrlToRevoke); sharedBlobUrlToRevoke = null; }
            }, 180000); // 3 דקות
         }
    }
});

// --- אירועי העתקה (ללא שינוי) ---
copySrtButton.addEventListener('click', async () => { /* ... */ });
copySrtButtonPlaceholder.addEventListener('click', () => copySrtButton.click());
copyPromptButton.addEventListener('click', async () => { /* ... */ });