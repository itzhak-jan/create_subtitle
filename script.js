// script.js (UI Controller) - VERSION 2 (FIXED)

document.addEventListener('DOMContentLoaded', async () => { // *** שינוי 1: הוספת async ***
    // --- משתנים גלובליים ל-UI ---
    let selectedFile = null;
    let currentSrtContent = '';
    let sharedBlobUrlToRevoke = null;
    let currentTranslations = {};
    let isModelLoading = true;
    let currentLang = 'he'; // שמירת השפה הנוכחית

    // --- רפרנסים לאלמנטים ---
    const allElements = {
        videoFileInput: document.getElementById('videoFile'),
        languageSelect: document.getElementById('languageSelect'),
        startButton: document.getElementById('startButton'),
        statusDiv: document.getElementById('status'),
        progressBar: document.getElementById('progressBar'),
        progressDetailDiv: document.getElementById('progressDetail'),
        downloadButtonsDiv: document.getElementById('downloadButtons'),
        downloadLinkSrt: document.getElementById('downloadLinkSrt'),
        downloadLinkTxt: document.getElementById('downloadLinkTxt'),
        copySrtButton: document.getElementById('copySrtButton'),
        heButton: document.getElementById('lang-he'),
        enButton: document.getElementById('lang-en'),
    };

    // --- אתחול ה-Worker ---
    const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });

    // --- ניהול תרגום (i18n) ---
    function getTranslation(key, replacements = {}) {
        let text = currentTranslations[key] || key; // אם אין תרגום, החזר את המפתח כדי שנדע מה חסר
        for (const placeholder in replacements) {
            text = text.replace(`{${placeholder}}`, replacements[placeholder]);
        }
        return text;
    }
    
    async function loadLanguage(lang) {
        try {
            const response = await fetch(`./locales/${lang}.json`);
            if (!response.ok) throw new Error(`Failed to load ${lang}.json`);
            currentTranslations = await response.json();
            currentLang = lang;
            applyTranslations(lang);
        } catch (error) {
            console.error("I18n Error:", error);
        }
    }

    function applyTranslations(lang) {
        document.documentElement.lang = lang;
        document.documentElement.dir = (lang === 'he') ? 'rtl' : 'ltr';

        document.querySelectorAll('[data-i18n-key]').forEach(element => {
            const key = element.getAttribute('data-i18n-key');
            if (currentTranslations[key]) {
                element.textContent = currentTranslations[key];
            }
        });

        document.querySelectorAll('[data-i18n-key-html]').forEach(element => {
            const key = element.getAttribute('data-i18n-key-html');
            if (currentTranslations[key]) {
                element.innerHTML = currentTranslations[key];
            }
        });
        
        allElements.heButton.classList.toggle('active', lang === 'he');
        allElements.enButton.classList.toggle('active', lang === 'en');
    }

    // --- פונקציות עזר ל-UI ---
    function updateStatus(textKey, progressValue = null, detailText = '') {
        allElements.statusDiv.textContent = getTranslation(textKey);
        allElements.progressDetailDiv.textContent = detailText;
        if (progressValue !== null && progressValue >= 0 && progressValue <= 100) {
            allElements.progressBar.style.display = 'block';
            allElements.progressBar.value = progressValue;
        } else {
            allElements.progressBar.style.display = 'none';
        }
    }

    function modelProgressCallback(data) {
        const { status, file = '', progress = 0 } = data;
        let detail = '';
        switch (status) {
            case 'initiate': detail = `Starting: ${file}`; break;
            case 'download': detail = `Downloading: ${file}`; break;
            case 'downloading': detail = `Downloading: ${file} (${progress.toFixed(1)}%)`; break;
            case 'progress': if (file) detail = `Processing: ${file} (${progress.toFixed(1)}%)`; break;
            case 'done': detail = `Completed: ${file}`; break;
        }
        updateStatus('statusLoadingModel', progress, detail);
    }
    
    function setControlsDisabled(disabled) {
        allElements.videoFileInput.disabled = disabled;
        allElements.languageSelect.disabled = disabled;
        allElements.startButton.disabled = disabled || !selectedFile;
    }

    // --- מאזינים לאירועים ---
    
    // תקשורת מה-Worker
    worker.onmessage = (event) => {
        const { status, data, textKey, progress, detail, message, srt } = event.data;

        switch (status) {
            case 'modelProgress':
                modelProgressCallback(data);
                break;
            case 'modelReady':
                isModelLoading = false;
                updateStatus('statusModelReady');
                setControlsDisabled(false);
                break;
            case 'update':
                 // *** מקבלים מפתח מה-worker במקום טקסט ***
                updateStatus(textKey, progress, detail);
                break;
            case 'transcriptionProgress':
                if (data.status === 'progress' && !data.file) {
                    const detailText = getTranslation('transcribingProgressDetail', { progress: data.progress?.toFixed(1) });
                    updateStatus('statusTranscribing', data.progress, detailText);
                }
                break;
            case 'done':
                currentSrtContent = srt;
                const fNameBase = selectedFile.name.substring(0, selectedFile.name.lastIndexOf('.')) || 'subtitles';
                const blob = new Blob([currentSrtContent], { type: 'text/plain;charset=utf-8' });
                if (sharedBlobUrlToRevoke) URL.revokeObjectURL(sharedBlobUrlToRevoke);
                sharedBlobUrlToRevoke = URL.createObjectURL(blob);

                allElements.downloadLinkSrt.href = sharedBlobUrlToRevoke;
                allElements.downloadLinkSrt.download = `${fNameBase}.srt`;
                allElements.downloadLinkSrt.style.display = 'inline-block';
                
                allElements.downloadLinkTxt.href = sharedBlobUrlToRevoke;
                allElements.downloadLinkTxt.download = `${fNameBase}.txt`;
                allElements.downloadLinkTxt.style.display = 'inline-block';

                allElements.copySrtButton.style.display = 'inline-block';
                allElements.downloadButtonsDiv.style.display = 'block';

                updateStatus('statusTranscriptionComplete');
                setControlsDisabled(false);
                break;
            case 'error':
                updateStatus('statusError', null, getTranslation('statusError', { message }));
                console.error("Error from worker:", message);
                setControlsDisabled(false);
                break;
        }
    };
    
    // אירועי משתמש
    allElements.videoFileInput.addEventListener('change', (event) => {
        selectedFile = event.target.files[0];
        if (selectedFile) {
            allElements.startButton.disabled = isModelLoading;
            updateStatus(isModelLoading ? 'statusLoadingModel' : 'statusFileSelected');
            allElements.downloadButtonsDiv.style.display = 'none';
        } else {
            allElements.startButton.disabled = true;
        }
    });

    allElements.startButton.addEventListener('click', () => {
        if (!selectedFile) return;
        setControlsDisabled(true);
        allElements.downloadButtonsDiv.style.display = 'none';
        worker.postMessage({
            type: 'transcribe',
            data: { file: selectedFile, language: allElements.languageSelect.value }
        });
    });
    
    allElements.copySrtButton.addEventListener('click', async () => {
        if (!currentSrtContent) return;
        try {
            await navigator.clipboard.writeText(currentSrtContent);
            const originalText = getTranslation('copyContentButton');
            allElements.copySrtButton.textContent = getTranslation('copiedButtonText');
            allElements.copySrtButton.disabled = true;
            setTimeout(() => {
                allElements.copySrtButton.textContent = originalText;
                allElements.copySrtButton.disabled = false;
            }, 2000);
        } catch (err) {
            console.error('Failed to copy: ', err);
            alert("Copy failed.");
        }
    });

    allElements.heButton.addEventListener('click', () => loadLanguage('he'));
    allElements.enButton.addEventListener('click', () => loadLanguage('en'));

    // --- אתחול ראשוני ---
    // *** שינוי 3: מחכים לטעינת השפה לפני שממשיכים ***
    await loadLanguage('he');
    setControlsDisabled(true); // מנוטרל עד שהמודל נטען
    updateStatus('statusLoadingModel');
    worker.postMessage({ type: 'loadModel' });
});