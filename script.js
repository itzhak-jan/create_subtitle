// script.js (Vanilla JS - טעינה מאוחרת + תיקון העתקה + תיקון Promise)

// --- ייבוא מהספרייה ---
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.1/dist/transformers.min.js';

// --- הגדרות סביבה ---
env.allowLocalModels = false;
env.allowRemoteModels = true;

// --- משתנים גלובליים ---
const MODEL_NAME = 'Xenova/whisper-tiny';
const TARGET_SAMPLE_RATE = 16000;
const TASK = 'transcribe';
let transcriber = null;
let isModelLoading = false;
let selectedFile = null;
let currentSrtContent = '';
let sharedBlobUrlToRevoke = null;

// --- מאזין לאירוע שה-DOM מוכן ---
document.addEventListener('DOMContentLoaded', () => {
    console.log("DOM fully loaded and parsed");

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

    if (!videoFileInput || !languageSelect || !startButton || !statusDiv || !progressBar || !progressDetailDiv || !downloadButtonsDiv || !downloadLinkSrt || !downloadLinkTxt || !copySrtButton || !copySrtButtonPlaceholder || !copyPromptButton) {
        console.error("Error: Essential HTML elements not found!");
        alert("שגיאה קריטית: רכיבי דף חסרים.");
        return;
    }
    console.log("All essential elements found.");

    // --- פונקציות עזר ---

    function updateStatus(text, progressValue = null, detailText = '') {
        statusDiv.textContent = text;
        progressDetailDiv.textContent = detailText;
        if (progressValue !== null && progressValue >= 0 && progressValue <= 100) {
            progressBar.style.display = 'block'; progressBar.value = progressValue;
        } else { progressBar.style.display = 'none'; }
    }

    async function extractAndResampleAudio(mediaFile) {
        updateStatus('קורא קובץ מדיה...', 0, 'מתחיל...');
        let audioContext;
        try {
            audioContext = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE });
            if (audioContext.state === 'suspended') await audioContext.resume();
        } catch (e) {
            console.error("Failed to create/resume AudioContext:", e);
            // *** תיקון: החזר Promise דחוי ***
            return Promise.reject(new Error(`שגיאה ביצירת הקשר אודיו: ${e.message}.`));
        }

        const fileReader = new FileReader();
        // *** תיקון: החזר את ה-Promise הזה ***
        return new Promise((resolve, reject) => {
            fileReader.onprogress = (event) => { if (event.lengthComputable) { const p = (event.loaded / event.total) * 100; updateStatus(`קורא (${Math.round(p)}%)`, p, `${Math.round(event.loaded/1e6)}MB/${Math.round(event.total/1e6)}MB`); } };
            fileReader.onload = async (event) => {
                try {
                    updateStatus('מפענח אודיו...', null, 'מעבד נתונים...');
                    if (!event.target?.result) {
                        // *** תיקון: השתמש ב-reject ***
                        reject(new Error("קריאת הקובץ לא החזירה נתונים.")); return;
                    }
                    const audioBuffer = await audioContext.decodeAudioData(event.target.result);
                    if (audioBuffer.length === 0) {
                         // *** תיקון: השתמש ב-reject ***
                         reject(new Error("קובץ האודיו ריק.")); return;
                    }
                    let processedBuffer;
                    if (audioBuffer.sampleRate !== TARGET_SAMPLE_RATE) {
                        updateStatus(`ממיר קצב דגימה...`, null, `מ-${audioBuffer.sampleRate}Hz`);
                        const offline = new OfflineAudioContext(audioBuffer.numberOfChannels, audioBuffer.duration * TARGET_SAMPLE_RATE, TARGET_SAMPLE_RATE);
                        const source = offline.createBufferSource(); source.buffer = audioBuffer; source.connect(offline.destination); source.start();
                        processedBuffer = await offline.startRendering();
                    } else { processedBuffer = audioBuffer; }
                    updateStatus('ממיר למונו...', null, '');
                    resolve(convertToMono(processedBuffer)); // קריאה ל-resolve בסיום מוצלח
                } catch (error) {
                    console.error("שגיאה בפענוח אודיו:", error);
                     // *** תיקון: השתמש ב-reject ***
                    reject(new Error(`שגיאה בפענוח אודיו: ${error.message}.`));
                } finally { if (audioContext?.state !== 'closed') audioContext.close().catch(console.error); }
            };
            fileReader.onerror = (error) => {
                 if (audioContext?.state !== 'closed') audioContext.close().catch(console.error);
                 // *** תיקון: השתמש ב-reject ***
                 reject(new Error(`שגיאה בקריאת הקובץ.`));
            }
            fileReader.readAsArrayBuffer(mediaFile);
        });
    }

    function convertToMono(audioBuffer) { /* ... כמו קודם ... */ if(audioBuffer.numberOfChannels===1)return audioBuffer.getChannelData(0);const nC=audioBuffer.numberOfChannels,nS=audioBuffer.length;const m=new Float32Array(nS);for(let i=0;i<nS;++i){let s=0;for(let j=0;j<nC;++j)s+=audioBuffer.getChannelData(j)[i];m[i]=s/nC;}return m;}
    function formatTimeToSRT(seconds) { /* ... כמו קודם ... */ if(isNaN(seconds)||seconds===null||seconds<0)return'00:00:00,000';const h=Math.floor(seconds/3600),m=Math.floor((seconds%3600)/60),s=Math.floor(seconds%60),ms=Math.floor((seconds-Math.floor(seconds))*1000);return`${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')},${String(ms).padStart(3,'0')}`; }
    function chunksToSRT(chunks) { /* ... כמו קודם ... */ let srt='',idx=1;chunks.forEach(c=>{if(c.timestamp&&typeof c.timestamp[0]==='number'&&typeof c.timestamp[1]==='number'&&c.timestamp[0]<=c.timestamp[1]&&c.text?.trim()){const sT=formatTimeToSRT(c.timestamp[0]),eT=formatTimeToSRT(c.timestamp[1]);srt+=`${idx++}\n${sT} --> ${eT}\n${c.text.trim()}\n\n`;}else{console.warn("Skipped chunk:",c);}});return srt;}
    function modelProgressCallback(data) { /* ... כמו קודם ... */ const{status,file='',progress=0,loaded,total}=data;let detail='';console.log("Progress:",data);switch(status){case'initiate':detail=`מתחיל:${file}`;updateStatus('טוען...',0,detail);break;case'download':detail=`מוריד:${file}`;updateStatus('טוען...',0,detail);break;case'downloading':detail=`מוריד:${file}(${progress.toFixed(1)}%)`;if(loaded&&total)detail+=` - ${Math.round(loaded/1e6)}MB/${Math.round(total/1e6)}MB`;updateStatus('טוען...',progress,detail);break;case'progress':if(file){detail=`מעבד:${file}(${progress.toFixed(1)}%)`;updateStatus('טוען...',progress,detail);}break;case'done':if(file)updateStatus('טוען...',100,`הושלם:${file}`);break;case'ready':updateStatus('מוכן.',null,'');break;default:console.log("Unknown status:",status);}}

    // --- פונקציית טעינת המודל ---
    async function loadTranscriptionModel() {
        if (transcriber) return transcriber;
        if (isModelLoading) return null;
        isModelLoading = true; videoFileInput.disabled = true; languageSelect.disabled = true; startButton.disabled = true;
        updateStatus('טוען מודל שפה...', 0, 'הורדה ראשונית עשויה לקחת זמן...');
        try {
            console.log("Attempting to load pipeline...");
            const loadedPipeline = await pipeline('automatic-speech-recognition', MODEL_NAME, { progress_callback: modelProgressCallback });
            transcriber = loadedPipeline; isModelLoading = false;
            console.log("Pipeline loaded successfully.");
            updateStatus('המודל נטען.', null, '');
            // אפשר פקדים אחרי שהמודל נטען בהצלחה
            videoFileInput.disabled = false; languageSelect.disabled = false; startButton.disabled = !selectedFile;
            return transcriber;
        } catch (error) {
            console.error("שגיאה קריטית בטעינת המודל:", error); updateStatus(`שגיאה בטעינת מודל: ${error.message}. רענן.`, null, '');
            isModelLoading = false; transcriber = null;
            videoFileInput.disabled = true; languageSelect.disabled = true; startButton.disabled = true; // השאר מנוטרל
            return null; // החזר null לציון כשל
        }
    }

    // --- אתחול ראשוני ---
    videoFileInput.disabled = false; languageSelect.disabled = false; startButton.disabled = true;
    updateStatus('אנא בחר קובץ ובחר שפה.', null, '');
    console.log("Initial UI state set.");

    // --- חיבור המאזינים לאירועים ---
    videoFileInput.addEventListener('change', (event) => {
        console.log("File input changed");
        selectedFile = event.target.files[0];
        if (selectedFile) {
            startButton.disabled = isModelLoading; // אפשר רק אם המודל לא בטעינה
            updateStatus(isModelLoading ? "טוען מודל..." : 'קובץ נבחר. לחץ "התחל תמלול".', null, '');
            downloadButtonsDiv.style.display = 'none'; copySrtButton.style.display = 'none'; copySrtButtonPlaceholder.style.display = 'none';
            if (sharedBlobUrlToRevoke) { URL.revokeObjectURL(sharedBlobUrlToRevoke); sharedBlobUrlToRevoke = null; }
        } else { startButton.disabled = true; updateStatus('אנא בחר קובץ.', null, ''); }
    });

    startButton.addEventListener('click', async () => {
        console.log("Start button clicked");
        if (!selectedFile) { updateStatus("לא נבחר קובץ.", null, ''); return; }

        videoFileInput.disabled = true; languageSelect.disabled = true; startButton.disabled = true;
        downloadButtonsDiv.style.display = 'none'; copySrtButton.style.display = 'none'; copySrtButtonPlaceholder.style.display = 'none';
        updateStatus('מתחיל...', 0, ''); currentSrtContent = '';
        if (sharedBlobUrlToRevoke) { URL.revokeObjectURL(sharedBlobUrlToRevoke); sharedBlobUrlToRevoke = null; }

        try {
            const currentTranscriber = await loadTranscriptionModel();
            if (!currentTranscriber) return; // שגיאה כבר דווחה

            updateStatus('מעבד קובץ אודיו...', 0, 'קורא ומפענח...');
            const audioData = await extractAndResampleAudio(selectedFile); // ממתין כאן
            if (!audioData) throw new Error("חילוץ האודיו נכשל או הוחזר ריק."); // בדיקה נוספת
            if (!audioData.every(Number.isFinite)) throw new Error("נתוני אודיו פגומים.");

            let langOpt = languageSelect.value, langCode = langOpt === 'auto' ? undefined : langOpt;
            updateStatus(`מתמלל (${langCode || 'אוטומטי'})...`, null, 'זה עלול לקחת זמן...');
            await new Promise(resolve => setTimeout(resolve, 50)); // זמן ל-UI

            const output = await currentTranscriber(audioData, {
                chunk_length_s: 30, stride_length_s: 5, language: langCode, task: TASK, return_timestamps: true,
                progress_callback: (p) => { if (p.status === 'progress' && !p.file) { updateStatus(`מתמלל (${p.progress?.toFixed(1)}%)...`, p.progress, 'מעבד...'); } }
            });

            console.log("Output:", output);
            updateStatus('מעבד תוצאות...', null, 'יוצר קבצים...');
            let genSrt = '';
            if (output?.chunks?.length) genSrt = chunksToSRT(output.chunks);
            else if (output?.text) { const dur = audioData.length / TARGET_SAMPLE_RATE; const fc = { timestamp: [0, dur || 1], text: output.text }; genSrt = chunksToSRT([fc]); }
            if (!genSrt) throw new Error("יצירת SRT נכשלה.");

            currentSrtContent = genSrt;
            const fNameBase = selectedFile.name.substring(0, selectedFile.name.lastIndexOf('.')) || 'subtitles';
            const blob = new Blob([currentSrtContent], { type: 'text/plain;charset=utf-8' });
            sharedBlobUrlToRevoke = URL.createObjectURL(blob);

            downloadLinkSrt.href = sharedBlobUrlToRevoke; downloadLinkSrt.download = `${fNameBase}.srt`; downloadLinkSrt.style.display = 'inline-block';
            downloadLinkTxt.href = sharedBlobUrlToRevoke; downloadLinkTxt.download = `${fNameBase}.txt`; downloadLinkTxt.style.display = 'inline-block';
            copySrtButton.style.display = 'inline-block'; copySrtButtonPlaceholder.style.display = 'inline-block';
            downloadButtonsDiv.style.display = 'block';
            updateStatus('התמלול הושלם!', null, '');

        } catch (error) {
            console.error("שגיאה:", error); statusDiv.textContent = `אירעה שגיאה: ${error.message}`;
            progressBar.style.display = 'none'; progressDetailDiv.textContent = '';
            downloadButtonsDiv.style.display = 'none'; copySrtButton.style.display = 'none'; copySrtButtonPlaceholder.style.display = 'none';
            currentSrtContent = '';
            if (sharedBlobUrlToRevoke) { URL.revokeObjectURL(sharedBlobUrlToRevoke); sharedBlobUrlToRevoke = null; }
        } finally {
            if (transcriber) { videoFileInput.disabled = false; languageSelect.disabled = false; startButton.disabled = !selectedFile; }
            else { videoFileInput.disabled = true; languageSelect.disabled = true; startButton.disabled = true; }
            if (sharedBlobUrlToRevoke) { setTimeout(() => { if (sharedBlobUrlToRevoke) { URL.revokeObjectURL(sharedBlobUrlToRevoke); sharedBlobUrlToRevoke = null; } }, 180000); }
        }
    });

    // --- אירועי העתקה (עם Fallback ו-getElementById לתקינות) ---
    copySrtButton.addEventListener('click', async () => {
        console.log("Copy SRT Clicked!");
        if (!currentSrtContent) { alert("אין תוכן להעתקה."); return; }
        try {
            if (!navigator.clipboard?.writeText) {
                 console.warn("Clipboard API not supported, using fallback.");
                 const textArea = document.createElement("textarea"); textArea.value = currentSrtContent; textArea.style.position = "fixed"; textArea.style.opacity = "0"; document.body.appendChild(textArea); textArea.focus(); textArea.select();
                 try { if (!document.execCommand('copy')) throw new Error('Fallback copy failed'); } catch (err) { throw err; } finally { document.body.removeChild(textArea); }
            } else { await navigator.clipboard.writeText(currentSrtContent); }
            const originalTextSrt = 'העתק תוכן'; copySrtButton.textContent = 'הועתק!'; copySrtButtonPlaceholder.textContent = 'הועתק!'; copySrtButton.disabled = true; copySrtButtonPlaceholder.disabled = true;
            setTimeout(() => { copySrtButton.textContent = originalTextSrt; copySrtButtonPlaceholder.textContent = originalTextSrt; copySrtButton.disabled = false; copySrtButtonPlaceholder.disabled = false; }, 2000);
        } catch (err) { console.error('Failed copy: ', err); alert("שגיאה בהעתקה."); copySrtButton.disabled = false; copySrtButtonPlaceholder.disabled = false; }
    });

    copySrtButtonPlaceholder.addEventListener('click', () => { if (!copySrtButton.disabled) copySrtButton.click(); });

    copyPromptButton.addEventListener('click', async () => {
        console.log("Copy Prompt Clicked!");
        const promptCodeElement = document.getElementById('promptTextElement'); // שימוש ב-ID
        if (!promptCodeElement) { alert("שגיאה: לא נמצא אלמנט טקסט ההנחיה (ID: promptTextElement)."); return; }
        const promptText = promptCodeElement.textContent || '';
        if (!promptText) { alert("שגיאה: טקסט ההנחיה ריק."); return; }
        try {
             if (!navigator.clipboard?.writeText) {
                 console.warn("Clipboard API not supported, using fallback.");
                 const textArea = document.createElement("textarea"); textArea.value = promptText; textArea.style.position = "fixed"; textArea.style.opacity = "0"; document.body.appendChild(textArea); textArea.focus(); textArea.select();
                 try { if (!document.execCommand('copy')) throw new Error('Fallback copy failed'); } catch (err) { throw err; } finally { document.body.removeChild(textArea); }
             } else { await navigator.clipboard.writeText(promptText); }
            const originalTextPrompt = 'העתק הנחיה'; copyPromptButton.textContent = 'הועתק!'; copyPromptButton.disabled = true;
            setTimeout(() => { copyPromptButton.textContent = originalTextPrompt; copyPromptButton.disabled = false; }, 2000);
        } catch (err) { console.error('Failed copy: ', err); alert("שגיאה בהעתקת ההנחיה."); copyPromptButton.disabled = false; }
    });

}); // סוף המאזין לאירוע DOMContentLoaded