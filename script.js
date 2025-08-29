// script.js (UI Controller) - VERSION 4 (WITH DOWNLOAD SPEED DISPLAY)

document.addEventListener('DOMContentLoaded', async () => {
    // --- State Management ---
    let state = {
        selectedFile: null,
        currentSrtContent: '',
        sharedBlobUrlToRevoke: null,
        currentTranslations: {},
        isModelLoading: true,
        currentLang: 'he',
        currentStatus: {
            key: 'statusLoadingModel',
            progress: null,
            detail: ''
        }
    };

    // --- Element References ---
    const elements = {
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

    // --- Worker Initialization ---
    const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });

    // --- I18n (Translation) Functions ---
    const getTranslation = (key, replacements = {}) => {
        let text = state.currentTranslations[key] || key;
        for (const placeholder in replacements) {
            text = text.replace(`{${placeholder}}`, replacements[placeholder]);
        }
        return text;
    };

    const applyTranslations = () => {
        const lang = state.currentLang;
        document.documentElement.lang = lang;
        document.documentElement.dir = (lang === 'he') ? 'rtl' : 'ltr';
        document.querySelectorAll('[data-i18n-key]').forEach(el => {
            const key = el.getAttribute('data-i18n-key');
            el.textContent = getTranslation(key);
        });
        document.querySelectorAll('[data-i18n-key-html]').forEach(el => {
            const key = el.getAttribute('data-i18n-key-html');
            el.innerHTML = getTranslation(key);
        });
        elements.heButton.classList.toggle('active', lang === 'he');
        elements.enButton.classList.toggle('active', lang === 'en');
        renderStatus();
    };

    const loadLanguage = async (lang) => {
        try {
            const response = await fetch(`./locales/${lang}.json`);
            if (!response.ok) throw new Error(`Failed to load ${lang}.json`);
            state.currentTranslations = await response.json();
            state.currentLang = lang;
            applyTranslations();
        } catch (error) {
            console.error("I18n Error:", error);
        }
    };

    // --- UI Update Functions ---
    const renderStatus = () => {
        const { key, progress, detail } = state.currentStatus;
        elements.statusDiv.textContent = getTranslation(key);
        elements.progressDetailDiv.textContent = detail;
        if (progress !== null && progress >= 0 && progress <= 100) {
            elements.progressBar.style.display = 'block';
            elements.progressBar.value = progress;
        } else {
            elements.progressBar.style.display = 'none';
        }
    };

    const updateStatus = (key, progress = null, detail = '') => {
        state.currentStatus = { key, progress, detail };
        renderStatus();
    };

    const modelProgressCallback = (data) => {
        // *** שינוי: פירוק המידע החדש מהאובייקט ***
        const { status, file = '', progress = 0, loaded, total, speedText } = data;
        let detail = '';
        
        switch (status) {
            case 'initiate':
                detail = `Starting: ${file}`;
                break;
            case 'download':
                detail = `Downloading: ${file}`;
                break;
            case 'downloading':
                // *** כאן בניית המחרוזת החדשה והמפורטת ***
                const loadedMB = (loaded / 1024 / 1024).toFixed(1);
                const totalMB = (total / 1024 / 1024).toFixed(1);
                // הוסף את מהירות ההורדה אם היא קיימת
                const speedInfo = speedText ? `@ ${speedText}` : '';
                
                detail = `Downloading: ${file} (${progress.toFixed(1)}%) - ${loadedMB}MB / ${totalMB}MB ${speedInfo}`;
                break;
            case 'progress':
                if (file) detail = `Processing: ${file} (${progress.toFixed(1)}%)`;
                break;
            case 'done':
                detail = `Completed: ${file}`;
                break;
        }
        updateStatus('statusLoadingModel', progress, detail);
    };

    const setControlsDisabled = (disabled) => {
        elements.videoFileInput.disabled = disabled;
        elements.languageSelect.disabled = disabled;
        elements.startButton.disabled = disabled || !state.selectedFile;
    };

    // --- Worker Event Listener ---
    worker.onmessage = (event) => {
        const { status, data, textKey, progress, detail, message, srt } = event.data;
        switch (status) {
            case 'modelProgress':
                modelProgressCallback(data);
                break;
            case 'modelReady':
                state.isModelLoading = false;
                updateStatus('statusModelReady');
                setControlsDisabled(false);
                break;
            case 'update':
                updateStatus(textKey, progress, detail);
                break;
            case 'transcriptionProgress':
                if (data.status === 'progress' && !data.file) {
                    const detailText = getTranslation('transcribingProgressDetail', { progress: data.progress?.toFixed(1) });
                    updateStatus('statusTranscribing', data.progress, detailText);
                }
                break;
            case 'done':
                state.currentSrtContent = srt;
                const fNameBase = state.selectedFile.name.substring(0, state.selectedFile.name.lastIndexOf('.')) || 'subtitles';
                const blob = new Blob([state.currentSrtContent], { type: 'text/plain;charset=utf-8' });
                if (state.sharedBlobUrlToRevoke) URL.revokeObjectURL(state.sharedBlobUrlToRevoke);
                state.sharedBlobUrlToRevoke = URL.createObjectURL(blob);
                elements.downloadLinkSrt.href = state.sharedBlobUrlToRevoke;
                elements.downloadLinkSrt.download = `${fNameBase}.srt`;
                elements.downloadLinkSrt.style.display = 'inline-block';
                elements.downloadLinkTxt.href = state.sharedBlobUrlToRevoke;
                elements.downloadLinkTxt.download = `${fNameBase}.txt`;
                elements.downloadLinkTxt.style.display = 'inline-block';
                elements.copySrtButton.style.display = 'inline-block';
                elements.downloadButtonsDiv.style.display = 'block';
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

    // --- User Event Listeners ---
    elements.videoFileInput.addEventListener('change', (event) => {
        state.selectedFile = event.target.files[0];
        if (state.selectedFile) {
            elements.startButton.disabled = state.isModelLoading;
            updateStatus(state.isModelLoading ? 'statusLoadingModel' : 'statusFileSelected');
            elements.downloadButtonsDiv.style.display = 'none';
        } else {
            elements.startButton.disabled = true;
        }
    });

    elements.startButton.addEventListener('click', () => {
        if (!state.selectedFile) return;
        setControlsDisabled(true);
        elements.downloadButtonsDiv.style.display = 'none';
        worker.postMessage({
            type: 'transcribe',
            data: { file: state.selectedFile, language: elements.languageSelect.value }
        });
    });

    elements.copySrtButton.addEventListener('click', async () => {
        if (!state.currentSrtContent) return;
        try {
            await navigator.clipboard.writeText(state.currentSrtContent);
            const originalText = getTranslation('copyContentButton');
            elements.copySrtButton.textContent = getTranslation('copiedText');
            elements.copySrtButton.disabled = true;
            setTimeout(() => {
                elements.copySrtButton.textContent = originalText;
                elements.copySrtButton.disabled = false;
            }, 2000);
        } catch (err) {
            console.error('Failed to copy: ', err);
            alert("Copy failed.");
        }
    });

    elements.heButton.addEventListener('click', () => loadLanguage('he'));
    elements.enButton.addEventListener('click', () => loadLanguage('en'));

    // --- Initial Page Load Sequence ---
    const initialize = async () => {
        setControlsDisabled(true);
        await loadLanguage('he');
        worker.postMessage({ type: 'loadModel' });
    };

    initialize();
});