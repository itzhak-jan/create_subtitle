// --- ייבוא מהספרייה ---
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.1';

// הגדרות סביבה
env.allowLocalModels = false;
env.allowRemoteModels = true;

// --- קבלת רפרנסים לאלמנטים ב-HTML ---
const videoFileInput = document.getElementById('videoFile');
const languageSelect = document.getElementById('languageSelect');
const startButton = document.getElementById('startButton'); // כפתור התחל חדש
const statusDiv = document.getElementById('status');
const progressBar = document.getElementById('progressBar');
const progressDetailDiv = document.getElementById('progressDetail'); // אלמנט להצגת פרטי התקדמות
const downloadButtonsDiv = document.getElementById('downloadButtons');
const downloadLinkSrt = document.getElementById('downloadLinkSrt');
const downloadLinkTxt = document.getElementById('downloadLinkTxt');
const copySrtButton = document.getElementById('copySrtButton'); // כפתור העתקת SRT
const copySrtButtonPlaceholder = document.getElementById('copySrtButtonPlaceholder'); // הכפתור בתוך ההוראות
const copyPromptButton = document.getElementById('copyPromptButton'); // כפתור העתקת הנחיה

// --- משתנים גלובליים ---
const MODEL_NAME = 'Xenova/whisper-tiny';
const TARGET_SAMPLE_RATE = 16000;
const TASK = 'transcribe';
let transcriber = null;
let isModelLoading = true;
let selectedFile = null; // לאחסון הקובץ שנבחר
let currentSrtContent = ''; // לאחסון תוכן ה-SRT הנוכחי להעתקה
let sharedBlobUrlToRevoke = null; // לאחסון ה-URL לשחרור

// --- פונקציות עזר ---

function updateStatus(text, progressValue = null, detailText = '') {
    statusDiv.textContent = text;
    progressDetailDiv.textContent = detailText; // עדכון טקסט פרטי ההתקדמות
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
                updateStatus(`קורא קובץ מדיה... (${Math.round(percentComplete)}%)`, percentComplete, `הורדו ${Math.round(event.loaded / 1024 / 1024)}MB מתוך ${Math.round(event.total / 1024 / 1024)}MB`);
            }
        };

        fileReader.onload = async (event) => {
            try {
                updateStatus('מפענח אודיו...', null, 'מעבד נתוני שמע גולמיים...');
                const audioBuffer = await audioContext.decodeAudioData(event.target.result);

                if (audioBuffer.length === 0) {
                    reject("קובץ האודיו ריק.");
                    return;
                }

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
                    const resampledBuffer = await offlineContext.startRendering();
                    resolve(convertToMono(resampledBuffer));
                } else {
                    updateStatus('ממיר למונו (אם נדרש)...', null, 'מכין ערוץ אודיו יחיד...');
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

function modelProgressCallback(data) {
    const status = data.status;
    const file = data.file || '';
    const progress = data.progress?.toFixed(2) || 0;
    let detailText = '';

    console.log("Model Progress Raw:", data);

    switch (status) {
        case 'initiate':
            updateStatus(`מאתחל הורדת קובץ מודל...`, 0, `קובץ: ${file}`);
            break;
        case 'download':
             updateStatus(`מתחיל הורדת קובץ מודל...`, 0, `קובץ: ${file}`);
             break;
        case 'downloading':
            detailText = `קובץ: ${file} (${progress}%)`;
            if (data.loaded && data.total) {
                 detailText += ` - ${Math.round(data.loaded / 1024 / 1024)}MB / ${Math.round(data.total / 1024 / 1024)}MB`;
            }
            updateStatus(`מוריד קובץ מודל...`, progress, detailText);
            break;
        case 'progress': // התקדמות כללית - יכול להיות טעינה או תמלול
             if (file) { // עדיין קשור לקובץ מודל ספציפי
                  updateStatus(`מעבד קובץ מודל...`, progress, `קובץ: ${file} (${progress}%)`);
             } else { // התקדמות תמלול
                  updateStatus(`מתמלל... (${progress}%)`, progress, `מעבד מקטע אודיו...`);
             }
            break;
        case 'done':
             if (file) {
                updateStatus(`הורדת/טעינת ${file} הושלמה.`, null, ''); // נקה פרטים
             }
            break;
        case 'ready':
            updateStatus('מודל התמלול מוכן.', null, ''); // נקה פרטים
            break;
        default:
             console.log(`סטטוס מודל לא מוכר: ${status}`, data);
    }
}

// --- אתחול ה-pipeline ---
pipeline('automatic-speech-recognition', MODEL_NAME, {
    progress_callback: modelProgressCallback,
}).then(loadedPipeline => {
    transcriber = loadedPipeline;
    isModelLoading = false;
    updateStatus('המודל נטען. אנא בחר קובץ ובחר שפה.', null, '');
    videoFileInput.disabled = false;
    languageSelect.disabled = false;
    // אל תפעיל את כפתור ההתחלה עדיין, חכה לבחירת קובץ
}).catch(error => {
    console.error("שגיאה קריטית בטעינת המודל:", error);
    updateStatus(`שגיאה חמורה בטעינת מודל השפה: ${error.message}. נסה לרענן את הדף.`, null, '');
    isModelLoading = false;
});

// נטרול ראשוני של הפקדים
videoFileInput.disabled = true;
languageSelect.disabled = true;
startButton.disabled = true;

// --- אירועים ---

// בעת בחירת קובץ: שמור את הקובץ ואפשר את כפתור ההתחלה
videoFileInput.addEventListener('change', (event) => {
    selectedFile = event.target.files[0];
    if (selectedFile && !isModelLoading && transcriber) {
        startButton.disabled = false; // אפשר את כפתור ההתחלה
        updateStatus('קובץ נבחר. לחץ "התחל תמלול".', null, '');
        // הסתר תוצאות קודמות אם קיימות
        downloadButtonsDiv.style.display = 'none';
        copySrtButton.style.display = 'none';
        copySrtButtonPlaceholder.style.display = 'none';
        // שחרר URL קודם אם קיים
        if (sharedBlobUrlToRevoke) {
             console.log('Revoking previous blob URL on new file selection');
             URL.revokeObjectURL(sharedBlobUrlToRevoke);
             sharedBlobUrlToRevoke = null;
        }
    } else {
        startButton.disabled = true; // נטרל אם אין קובץ או שהמודל לא מוכן
        selectedFile = null;
        if (!transcriber && !isModelLoading) {
            updateStatus("טעינת המודל נכשלה. רענן את הדף.", null, '');
        } else if (isModelLoading) {
             updateStatus("המודל עדיין בטעינה...", null, '');
        } else {
            updateStatus('אנא בחר קובץ.', null, '');
        }
    }
});

// בעת לחיצה על "התחל תמלול"
startButton.addEventListener('click', async () => {
    if (!selectedFile) {
        updateStatus("שגיאה: לא נבחר קובץ.", null, '');
        return;
    }
    if (!transcriber) {
        updateStatus("שגיאה: המודל לא נטען כראוי.", null, '');
        return;
    }

    // השבת פקדים והסתר תוצאות קודמות
    videoFileInput.disabled = true;
    languageSelect.disabled = true;
    startButton.disabled = true;
    downloadButtonsDiv.style.display = 'none';
    copySrtButton.style.display = 'none';
    copySrtButtonPlaceholder.style.display = 'none';
    updateStatus('מתחיל עיבוד קובץ...', 0, 'מכין את הקובץ...');
    currentSrtContent = ''; // אפס תוכן קודם

    // נקה URL קודם אם עדיין קיים
     if (sharedBlobUrlToRevoke) {
        console.log('Revoking previous blob URL before starting new process');
        URL.revokeObjectURL(sharedBlobUrlToRevoke);
        sharedBlobUrlToRevoke = null;
     }

    try {
        // 1. חילוץ והמרת אודיו
        const audioData = await extractAndResampleAudio(selectedFile);

        // בדיקות ניפוי שגיאות לאודיו
        console.log('Audio Data Sample (first 10):', audioData ? audioData.slice(0, 10) : 'N/A');
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
        let selectedLanguageOption = languageSelect.value;
        let langForWhisper = selectedLanguageOption === 'auto' ? undefined : selectedLanguageOption;
        let langDisplay = selectedLanguageOption === 'auto' ? 'זיהוי אוטומטי' : languageSelect.options[languageSelect.selectedIndex].text;
        updateStatus(`מתמלל (שפה: ${langDisplay})...`, null, 'מעביר למודל Whisper...');

        // 2. הפעלת התמלול
        const output = await transcriber(audioData, {
            chunk_length_s: 30,
            stride_length_s: 5,
            language: langForWhisper,
            task: TASK,
            return_timestamps: true,
            progress_callback: (progressData) => { // הוספת callback גם כאן להתקדמות התמלול עצמו
                 if(progressData.status === 'progress' && !progressData.file) {
                     const transcriptionProgress = progressData.progress?.toFixed(2) || 0;
                     updateStatus(`מתמלל (${transcriptionProgress}%)`, transcriptionProgress, `מעבד מקטע אודיו...`);
                 } else {
                     // עדכן עבור סטטוסים אחרים אם צריך
                      modelProgressCallback(progressData);
                 }
            }
        });

        console.log("Transcription Output:", output);
        updateStatus('מעבד תוצאות ויוצר קבצים להורדה...', null, 'מפרמט כתוביות...');

        // 3. יצירת תוכן SRT
        let generatedSrtContent = ''; // שם חדש כדי לא להתנגש עם הגלובלי מיד
        if (output && output.chunks && output.chunks.length > 0) {
            generatedSrtContent = chunksToSRT(output.chunks);
        } else if (output && output.text && output.text.trim().length > 0) {
            console.warn("יוצר SRT עם טקסט כללי.");
            const duration = audioData.length / TARGET_SAMPLE_RATE;
            const fakeChunk = { timestamp: [0, duration || 1], text: output.text };
            generatedSrtContent = chunksToSRT([fakeChunk]);
        }
        if (!generatedSrtContent) {
            throw new Error("יצירת תוכן SRT נכשלה (לא נמצאו מקטעים תקינים).");
        }
        currentSrtContent = generatedSrtContent; // עדכן את המשתנה הגלובלי

        // 4. יצירת קישורים להורדה (עם אותו תוכן SRT)
        const originalFileName = selectedFile.name.substring(0, selectedFile.name.lastIndexOf('.')) || 'subtitles';
        const blobContent = new Blob([currentSrtContent], { type: 'text/plain;charset=utf-8' });
        sharedBlobUrlToRevoke = URL.createObjectURL(blobContent); // שמור URL לשחרור

        downloadLinkSrt.href = sharedBlobUrlToRevoke;
        downloadLinkSrt.download = `${originalFileName}.srt`;
        downloadLinkSrt.style.display = 'inline-block';

        downloadLinkTxt.href = sharedBlobUrlToRevoke;
        downloadLinkTxt.download = `${originalFileName}.txt`;
        downloadLinkTxt.style.display = 'inline-block';

        copySrtButton.style.display = 'inline-block'; // הצג כפתור העתקה
        copySrtButtonPlaceholder.style.display = 'inline-block'; // הצג גם את הכפתור בהוראות
        downloadButtonsDiv.style.display = 'block'; // הצג את כל אזור ההורדה

        updateStatus('התמלול הושלם! לחץ על הקישור הרצוי להורדה.', null, '');

    } catch (error) {
        console.error("שגיאה בתהליך התמלול:", error);
        statusDiv.textContent = `אירעה שגיאה: ${error.message}`;
        progressBar.style.display = 'none';
        progressDetailDiv.textContent = ''; // נקה פרטי התקדמות
        downloadButtonsDiv.style.display = 'none'; // הסתר קישורים
        copySrtButton.style.display = 'none';
        copySrtButtonPlaceholder.style.display = 'none';
        currentSrtContent = ''; // אפס תוכן להעתקה

        // נסה לשחרר URL אם נוצר לפני השגיאה
        if (sharedBlobUrlToRevoke) {
            console.log('Revoking blob URL after error');
            URL.revokeObjectURL(sharedBlobUrlToRevoke);
            sharedBlobUrlToRevoke = null;
        }

    } finally {
        // אפשר פקדים מחדש (אם המודל נטען בהצלחה במקור)
        if (!isModelLoading) {
             videoFileInput.disabled = false;
             languageSelect.disabled = false;
             // אפשר את כפתור ההתחלה רק אם יש עדיין קובץ שנבחר
             startButton.disabled = !selectedFile;
        } else {
            // אם המודל נכשל בטעינה, השאר הכל מנוטרל
             videoFileInput.disabled = true;
             languageSelect.disabled = true;
             startButton.disabled = true;
        }

         // שחרור כתובת ה-URL לאחר זמן (רק אם לא שוחררה כבר ב-catch)
         if (sharedBlobUrlToRevoke) {
            setTimeout(() => {
                if (sharedBlobUrlToRevoke) { // בדוק שוב אם הוא עדיין קיים
                     console.log('Revoking shared blob URL after timeout');
                     URL.revokeObjectURL(sharedBlobUrlToRevoke);
                     sharedBlobUrlToRevoke = null;
                }
            }, 180000); // 3 דקות
         }
    }
});

// העתקת תוכן SRT/TXT ללוח
copySrtButton.addEventListener('click', async () => {
    if (!currentSrtContent) {
        alert("אין תוכן להעתקה.");
        return;
    }
    try {
        await navigator.clipboard.writeText(currentSrtContent);
        // משוב למשתמש
        const originalText = copySrtButton.textContent;
        copySrtButton.textContent = 'הועתק!';
        copySrtButtonPlaceholder.textContent = 'הועתק!';
        setTimeout(() => {
            copySrtButton.textContent = originalText;
            copySrtButtonPlaceholder.textContent = originalText;
        }, 2000); // החזר טקסט מקורי אחרי 2 שניות
    } catch (err) {
        console.error('Failed to copy SRT content: ', err);
        alert("שגיאה בהעתקה ללוח.");
    }
});
// סנכרון שני כפתורי ההעתקה
copySrtButtonPlaceholder.addEventListener('click', () => copySrtButton.click());


// העתקת ההנחיה המומלצת ל-AI
copyPromptButton.addEventListener('click', async () => {
    const promptText = `אנא תקן את הטקסט הבא, המגיע מקובץ כתוביות (התעלם ממספרי השורות וחותמות הזמן): סדר את המשפטים, תקן שגיאות כתיב ודקדוק, הוסף פיסוק הגיוני, וודא שהתחביר קריא וברור. שמור על המשמעות המקורית.`;
    try {
        await navigator.clipboard.writeText(promptText);
        // משוב למשתמש
        const originalText = copyPromptButton.textContent;
        copyPromptButton.textContent = 'הועתק!';
        setTimeout(() => {
            copyPromptButton.textContent = originalText;
        }, 2000);
    } catch (err) {
        console.error('Failed to copy prompt: ', err);
        alert("שגיאה בהעתקת ההנחיה.");
    }
});