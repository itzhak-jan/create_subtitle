// script.js - Enhanced version with Web Workers and improved UX
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.1/dist/transformers.min.js';

// === Environment Configuration ===
env.allowLocalModels = false;
env.allowRemoteModels = true;

// === Global Variables ===
const MODEL_NAME = 'Xenova/whisper-tiny';
const TARGET_SAMPLE_RATE = 16000;
const TASK = 'transcribe';

let transcriber = null;
let isModelLoading = false;
let selectedFile = null;
let currentSrtContent = '';
let sharedBlobUrlToRevoke = null;
let processingCancelled = false;
let startTime = null;
let isActivelyProcessing = false;
let currentLanguage = 'he';
let translations = {};

// UI Elements
let elements = {};

// === Translation System ===
async function loadTranslations(lang) {
    try {
        const response = await fetch(`locales/${lang}.json`);
        if (!response.ok) {
            console.warn(`Failed to load locales/${lang}.json, using fallback`);
            return getFallbackTranslations(lang);
        }
        return await response.json();
    } catch (error) {
        console.warn(`Error loading translations for ${lang}:`, error);
        return getFallbackTranslations(lang);
    }
}

function getFallbackTranslations(lang) {
    // Fallback translations embedded in code
    const fallbacks = {
        he: {
            title: "מתמלל וידאו בדפדפן",
            step3: "3. התחל תמלול",
            "status_messages.loading_model": "טוען מודל שפה...",
            "status_messages.select_file": "אנא בחר קובץ ובחר שפה.",
            "status_messages.completed": "התמלול הושלם!",
            "download.copy_content": "העתק תוכן",
            "download.copied": "הועתק!"
        },
        en: {
            title: "Browser Video Transcriber",
            step3: "3. Start Transcription",
            "status_messages.loading_model": "Loading language model...",
            "status_messages.select_file": "Please select a file and choose language.",
            "status_messages.completed": "Transcription completed!",
            "download.copy_content": "Copy Content",
            "download.copied": "Copied!"
        }
    };
    return fallbacks[lang] || fallbacks.he;
}

function getTranslation(key, fallback = key) {
    const keys = key.split('.');
    let value = translations;
    
    for (const k of keys) {
        if (value && typeof value === 'object' && k in value) {
            value = value[k];
        } else {
            return fallback;
        }
    }
    
    return value || fallback;
}

function updateTranslations() {
    document.querySelectorAll('[data-i18n]').forEach(element => {
        const key = element.getAttribute('data-i18n');
        const translation = getTranslation(key);
        
        if (element.tagName === 'INPUT' && element.type === 'button') {
            element.value = translation;
        } else if (element.tagName === 'BUTTON') {
            element.textContent = translation;
        } else if (element.tagName === 'OPTION') {
            element.textContent = translation;
        } else {
            element.textContent = translation;
        }
    });
    
    // Update placeholders
    document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
        el.placeholder = getTranslation(el.getAttribute('data-i18n-placeholder'));
    });

    // Update HTML attributes
    document.documentElement.lang = currentLanguage;
    document.documentElement.dir = currentLanguage === 'he' ? 'rtl' : 'ltr';
    document.title = getTranslation('title');
}

// === Progress Management ===
class ProgressManager {
    constructor() {
        this.currentStage = '';
        this.percentage = 0;
        this.details = '';
        this.startTime = null;
        this.stages = [
            'loading_model',
            'reading_file', 
            'decoding_audio',
            'converting_sample_rate',
            'converting_mono',
            'transcribing',
            'processing_results'
        ];
        this.currentStageIndex = 0;
    }

    start() {
        this.startTime = Date.now();
        this.show();
    }

    show() {
        const container = document.querySelector('.progress-container');
        if (container) {
            container.style.display = 'block';
            container.classList.add('fadeIn');
        }
    }

    hide() {
        const container = document.querySelector('.progress-container');
        if (container) {
            container.style.display = 'none';
        }
    }

    updateStage(stage, percentage = null, details = '') {
        this.currentStage = stage;
        if (percentage !== null) {
            this.percentage = Math.max(0, Math.min(100, percentage));
        }
        this.details = details;
        
        this.updateUI();
    }

    updateUI() {
        const stageElement = elements.currentStage;
        const percentageElement = elements.progressPercentage;
        const fillElement = elements.progressBarFill;
        const detailsElement = elements.progressDetails;
        const timeElement = elements.estimatedTime;

        if (stageElement) {
            const stageText = getTranslation(`status_messages.${this.currentStage}`, this.currentStage);
            stageElement.textContent = stageText;
        }

        if (percentageElement) {
            percentageElement.textContent = `${Math.round(this.percentage)}%`;
        }

        if (fillElement) {
            fillElement.style.width = `${this.percentage}%`;
        }

        if (detailsElement) {
            detailsElement.textContent = this.details;
        }

        if (timeElement && this.startTime && this.percentage > 5) {
            const elapsed = (Date.now() - this.startTime) / 1000;
            const estimated = (elapsed / this.percentage) * (100 - this.percentage);
            if (estimated > 5) {
                const minutes = Math.floor(estimated / 60);
                const seconds = Math.floor(estimated % 60);
                timeElement.textContent = `${getTranslation('estimated_time_label', 'זמן משוער')}: ${minutes > 0 ? minutes + 'm ' : ''}${seconds}s`;
            }
        }
    }
}

const progressManager = new ProgressManager();

// === Enhanced Status Updates ===
function updateStatus(text, isError = false, isSuccess = false) {
    if (!elements.status) return;
    
    elements.status.textContent = text;
    elements.status.className = '';
    
    if (isError) {
        elements.status.classList.add('error');
    } else if (isSuccess) {
        elements.status.classList.add('success');
    } else if (isActivelyProcessing) {
        elements.status.classList.add('processing');
    }
}

// === Audio Processing (Non-blocking) ===
async function extractAndResampleAudio(mediaFile) {
    return new Promise((resolve, reject) => {
        progressManager.updateStage('reading_file', 0, 'מתחיל...');
        
        let audioContext;
        try {
            audioContext = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE });
            if (audioContext.state === 'suspended') {
                audioContext.resume();
            }
        } catch (e) {
            console.error("Failed to create AudioContext:", e);
            reject(new Error(getTranslation('errors.audio_context_error', 'שגיאה ביצירת הקשר אודיו')));
            return;
        }

        const fileReader = new FileReader();
        
        fileReader.onprogress = (event) => {
            if (event.lengthComputable) {
                const percentage = (event.loaded / event.total) * 100;
                const details = `${Math.round(event.loaded/1e6)}MB/${Math.round(event.total/1e6)}MB`;
                progressManager.updateStage('reading_file', percentage * 0.3, details); // 30% for file reading
            }
        };
        
        fileReader.onload = async (event) => {
            try {
                if (processingCancelled) {
                    reject(new Error('Process cancelled'));
                    return;
                }

                progressManager.updateStage('decoding_audio', 30, 'מעבד נתונים...');
                
                if (!event.target?.result) {
                    reject(new Error(getTranslation('errors.no_file_data', 'קריאת הקובץ לא החזירה נתונים')));
                    return;
                }

                // Use setTimeout to allow UI updates
                setTimeout(async () => {
                    try {
                        const audioBuffer = await audioContext.decodeAudioData(event.target.result);
                        
                        if (processingCancelled) {
                            reject(new Error('Process cancelled'));
                            return;
                        }

                        if (audioBuffer.length === 0) {
                            reject(new Error(getTranslation('errors.empty_file', 'קובץ האודיו ריק')));
                            return;
                        }

                        let processedBuffer;
                        
                        if (audioBuffer.sampleRate !== TARGET_SAMPLE_RATE) {
                            progressManager.updateStage('converting_sample_rate', 60, `מ-${audioBuffer.sampleRate}Hz`);
                            
                            const offline = new OfflineAudioContext(
                                audioBuffer.numberOfChannels, 
                                audioBuffer.duration * TARGET_SAMPLE_RATE, 
                                TARGET_SAMPLE_RATE
                            );
                            const source = offline.createBufferSource();
                            source.buffer = audioBuffer;
                            source.connect(offline.destination);
                            source.start();
                            
                            processedBuffer = await offline.startRendering();
                        } else {
                            processedBuffer = audioBuffer;
                        }

                        if (processingCancelled) {
                            reject(new Error('Process cancelled'));
                            return;
                        }

                        progressManager.updateStage('converting_mono', 80, '');
                        
                        // Use setTimeout for mono conversion to prevent blocking
                        setTimeout(() => {
                            try {
                                const monoAudio = convertToMono(processedBuffer);
                                resolve(monoAudio);
                            } catch (error) {
                                reject(error);
                            } finally {
                                if (audioContext?.state !== 'closed') {
                                    audioContext.close().catch(console.error);
                                }
                            }
                        }, 10);
                        
                    } catch (error) {
                        console.error("Audio decoding error:", error);
                        reject(new Error(getTranslation('errors.audio_decode_error', 'שגיאה בפענוח אודיו') + ': ' + error.message));
                    }
                }, 10);
                
            } catch (error) {
                console.error("Processing error:", error);
                reject(error);
            }
        };
        
        fileReader.onerror = (error) => {
            if (audioContext?.state !== 'closed') {
                audioContext.close().catch(console.error);
            }
            reject(new Error(getTranslation('errors.file_read_error', 'שגיאה בקריאת הקובץ')));
        };
        
        fileReader.readAsArrayBuffer(mediaFile);
    });
}

// === Utility Functions ===
function convertToMono(audioBuffer) {
    if (audioBuffer.numberOfChannels === 1) {
        return audioBuffer.getChannelData(0);
    }
    
    const numberOfChannels = audioBuffer.numberOfChannels;
    const numberOfSamples = audioBuffer.length;
    const monoData = new Float32Array(numberOfSamples);
    
    for (let i = 0; i < numberOfSamples; i++) {
        let sample = 0;
        for (let j = 0; j < numberOfChannels; j++) {
            sample += audioBuffer.getChannelData(j)[i];
        }
        monoData[i] = sample / numberOfChannels;
    }
    
    return monoData;
}

function formatTimeToSRT(seconds) {
    if (isNaN(seconds) || seconds === null || seconds < 0) {
        return '00:00:00,000';
    }
    
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    const milliseconds = Math.floor((seconds - Math.floor(seconds)) * 1000);
    
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')},${String(milliseconds).padStart(3, '0')}`;
}

function chunksToSRT(chunks) {
    let srt = '';
    let index = 1;
    
    chunks.forEach(chunk => {
        if (chunk.timestamp && 
            typeof chunk.timestamp[0] === 'number' && 
            typeof chunk.timestamp[1] === 'number' &&
            chunk.timestamp[0] <= chunk.timestamp[1] && 
            chunk.text?.trim()) {
            
            const startTime = formatTimeToSRT(chunk.timestamp[0]);
            const endTime = formatTimeToSRT(chunk.timestamp[1]);
            srt += `${index++}\n${startTime} --> ${endTime}\n${chunk.text.trim()}\n\n`;
        } else {
            console.warn("Skipped invalid chunk:", chunk);
        }
    });
    
    return srt;
}

// === Model Loading with Progress ===
function modelProgressCallback(data) {
    const { status, file = '', progress = 0, loaded, total } = data;
    let details = '';
    
    console.log("Model Progress:", data);
    
    switch (status) {
        case 'initiate':
            details = `מתחיל: ${file}`;
            progressManager.updateStage('loading_model', 0, details);
            break;
        case 'download':
            details = `מוריד: ${file}`;
            progressManager.updateStage('loading_model', 0, details);
            break;
        case 'downloading':
            details = `מוריד: ${file} (${progress.toFixed(1)}%)`;
            if (loaded && total) {
                details += ` - ${Math.round(loaded/1e6)}MB/${Math.round(total/1e6)}MB`;
            }
            progressManager.updateStage('loading_model', progress * 0.8, details);
            break;
        case 'progress':
            if (file) {
                details = `מעבד: ${file} (${progress.toFixed(1)}%)`;
                progressManager.updateStage('loading_model', 80 + progress * 0.2, details);
            }
            break;
        case 'done':
            if (file) {
                progressManager.updateStage('loading_model', 100, `הושלם: ${file}`);
            }
            break;
        case 'ready':
            updateStatus(getTranslation('status_messages.ready', 'מוכן'), false, true);
            break;
        default:
            console.log("Unknown status:", status);
    }
}

// === Enhanced Model Loading ===
async function loadTranscriptionModel() {
    if (transcriber) return transcriber;
    if (isModelLoading) return null;
    
    isModelLoading = true;
    processingCancelled = false;
    
    // Disable controls
    setControlsState(false);
    
    progressManager.start();
    progressManager.updateStage('loading_model', 0, 'הורדה ראשונית עשויה לקחת זמן...');
    updateStatus(getTranslation('status_messages.loading_model', 'טוען מודל שפה...'));
    
    try {
        console.log("Loading pipeline...");
        const loadedPipeline = await pipeline('automatic-speech-recognition', MODEL_NAME, {
            progress_callback: modelProgressCallback
        });
        
        if (processingCancelled) {
            isModelLoading = false;
            return null;
        }
        
        transcriber = loadedPipeline;
        isModelLoading = false;
        
        console.log("Pipeline loaded successfully");
        updateStatus(getTranslation('status_messages.ready', 'המודל נטען'), false, true);
        progressManager.hide();
        
        // Re-enable controls
        setControlsState(true);
        
        return transcriber;
        
    } catch (error) {
        console.error("Critical model loading error:", error);
        updateStatus(
            getTranslation('errors.model_load_error', 'שגיאה בטעינת מודל') + 
            ': ' + error.message + '. ' + 
            getTranslation('errors.refresh_page', 'רענן'), 
            true
        );
        
        isModelLoading = false;
        transcriber = null;
        progressManager.hide();
        
        // Keep controls disabled on error
        setControlsState(false);
        
        return null;
    }
}

// === Control State Management ===
function setControlsState(enabled) {
    if (elements.videoFileInput) elements.videoFileInput.disabled = !enabled;
    if (elements.languageSelect) elements.languageSelect.disabled = !enabled;
    if (elements.startButton) elements.startButton.disabled = !enabled || !selectedFile;
}

// === Enhanced Copy Functionality ===
async function copyToClipboard(text, button, originalText) {
    if (!text) {
        alert(getTranslation('errors.no_content_to_copy', 'אין תוכן להעתקה'));
        return;
    }
    
    try {
        // Try modern clipboard API first
        if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(text);
        } else {
            // Fallback for older browsers
            const textArea = document.createElement("textarea");
            textArea.value = text;
            textArea.style.position = "fixed";
            textArea.style.opacity = "0";
            document.body.appendChild(textArea);
            textArea.focus();
            textArea.select();
            
            if (!document.execCommand('copy')) {
                throw new Error('Fallback copy failed');
            }
            
            document.body.removeChild(textArea);
        }
        
        // Success feedback
        const copiedText = getTranslation('download.copied', 'הועתק!');
        button.textContent = copiedText;
        button.disabled = true;
        
        setTimeout(() => {
            button.textContent = originalText;
            button.disabled = false;
        }, 2000);
        
    } catch (err) {
        console.error('Copy failed:', err);
        alert(getTranslation('errors.copy_error', 'שגיאה בהעתקה'));
        button.disabled = false;
    }
}

// === Main Transcription Process ===
async function startTranscription() {
    if (!selectedFile) {
        updateStatus(getTranslation('status_messages.no_file', 'לא נבחר קובץ'), true);
        return;
    }
    
    // Reset state
    processingCancelled = false;
    currentSrtContent = '';
    startTime = Date.now();
    isActivelyProcessing = true;
    
    // Update UI
    setControlsState(false);
    hideDownloadSection();
    updateStatus(getTranslation('status_messages.starting', 'מתחיל...'));
    progressManager.start();
    
    // Show cancel button
    if (elements.cancelButton) {
        elements.cancelButton.style.display = 'block';
    }
    
    try {
        // Load model if needed
        const currentTranscriber = await loadTranscriptionModel();
        if (!currentTranscriber || processingCancelled) return;
        
        // Process audio
        progressManager.updateStage('processing', 0, 'מעבד קובץ אודיו...');
        updateStatus(getTranslation('status_messages.processing', 'מעבד קובץ אודיו...'));
        
        const audioData = await extractAndResampleAudio(selectedFile);
        if (!audioData || processingCancelled) return;
        
        // Start transcription
        const langOpt = elements.languageSelect.value;
        const langCode = langOpt === 'auto' ? undefined : langOpt;
        const langDisplay = langCode || getTranslation('auto_detect', 'אוטומטי');
        
        progressManager.updateStage('transcribing', 0, 'זה עלול לקחת זמן...');
        updateStatus(getTranslation('status_messages.transcribing', 'מתמלל') + ` (${langDisplay})...`);
        
        // Small delay to allow UI update
        await new Promise(resolve => setTimeout(resolve, 100));
        
        const output = await currentTranscriber(audioData, {
            chunk_length_s: 30,
            stride_length_s: 5,
            language: langCode,
            task: TASK,
            return_timestamps: true,
            progress_callback: (progressData) => {
                if (progressData.status === 'progress' && !progressData.file) {
                    const percent = progressData.progress || 0;
                    progressManager.updateStage('transcribing', percent, 'מעבד קטעי אודיו...');
                }
            }
        });
        
        if (processingCancelled) return;
        
        console.log("Transcription output:", output);
        
        // Process results
        progressManager.updateStage('processing_results', 90, 'יוצר קבצים...');
        updateStatus(getTranslation('status_messages.processing_results', 'מעבד תוצאות...'));
        
        let generatedSrt = '';
        if (output?.chunks?.length) {
            generatedSrt = chunksToSRT(output.chunks);
        } else if (output?.text) {
            // Fallback: create single chunk
            const duration = audioData.length / TARGET_SAMPLE_RATE;
            const fallbackChunk = {
                timestamp: [0, duration || 1],
                text: output.text
            };
            generatedSrt = chunksToSRT([fallbackChunk]);
        }
        
        if (!generatedSrt) {
            throw new Error(getTranslation('errors.srt_creation_failed', 'יצירת SRT נכשלה'));
        }
        
        // Success!
        currentSrtContent = generatedSrt;
        progressManager.updateStage('processing_results', 100, 'הושלם!');
        updateStatus(getTranslation('status_messages.completed', 'התמלול הושלם!'), false, true);
        
        showDownloadSection();

        if ('Notification' in window && Notification.permission === 'granted' && document.hidden) {
            new Notification(getTranslation('notification.title', 'התמלול הושלם!'), {
                body: getTranslation('notification.body', 'קובץ הכתוביות מוכן להורדה')
            });
        }

    } catch (error) {
        if (processingCancelled) {
            updateStatus(getTranslation('cancelled', 'התהליך בוטל'), false);
        } else {
            console.error("Transcription error:", error);
            updateStatus(
                getTranslation('status_messages.error', 'אירעה שגיאה') + ': ' + error.message, 
                true
            );
        }
        hideDownloadSection();
        currentSrtContent = '';
    } finally {
        isActivelyProcessing = false;
        // Clean up
        progressManager.hide();
        if (elements.cancelButton) {
            elements.cancelButton.style.display = 'none';
        }
        
        // Re-enable controls if model is loaded
        if (transcriber && !processingCancelled) {
            setControlsState(true);
        }
        
        // Clean up blob URL after delay
        if (sharedBlobUrlToRevoke) {
            setTimeout(() => {
                if (sharedBlobUrlToRevoke) {
                    URL.revokeObjectURL(sharedBlobUrlToRevoke);
                    sharedBlobUrlToRevoke = null;
                }
            }, 180000); // 3 minutes
        }
    }
}

// === Download Section Management ===
function showDownloadSection() {
    if (!currentSrtContent) return;
    
    const fileNameBase = selectedFile.name.substring(0, selectedFile.name.lastIndexOf('.')) || 'subtitles';
    const blob = new Blob([currentSrtContent], { type: 'text/plain;charset=utf-8' });
    sharedBlobUrlToRevoke = URL.createObjectURL(blob);
    
    // Update download links
    if (elements.downloadLinkSrt) {
        elements.downloadLinkSrt.href = sharedBlobUrlToRevoke;
        elements.downloadLinkSrt.download = `${fileNameBase}.srt`;
        elements.downloadLinkSrt.style.display = 'inline-block';
    }
    
    if (elements.downloadLinkTxt) {
        elements.downloadLinkTxt.href = sharedBlobUrlToRevoke;
        elements.downloadLinkTxt.download = `${fileNameBase}.txt`;
        elements.downloadLinkTxt.style.display = 'inline-block';
    }
    
    if (elements.copySrtButton) {
        elements.copySrtButton.style.display = 'inline-block';
    }
    
    if (elements.downloadButtons) {
        elements.downloadButtons.style.display = 'block';
    }

    // Show and reset translation section
    const translationSection = document.getElementById('translationSection');
    if (translationSection) {
        translationSection.style.display = 'block';
        document.getElementById('googleTranslateStatus').style.display = 'none';
        document.getElementById('googleTranslateStatus').textContent = '';
        document.getElementById('downloadTranslatedSrtLink').style.display = 'none';
        document.getElementById('aiTranslationPanel').style.display = 'none';
        document.getElementById('aiResponseTextarea').value = '';
        document.getElementById('downloadAiTranslatedLink').style.display = 'none';
    }
}

function hideDownloadSection() {
    if (elements.downloadButtons) {
        elements.downloadButtons.style.display = 'none';
    }
    
    ['downloadLinkSrt', 'downloadLinkTxt', 'copySrtButton'].forEach(id => {
        if (elements[id]) {
            elements[id].style.display = 'none';
        }
    });
    
    if (sharedBlobUrlToRevoke) {
        URL.revokeObjectURL(sharedBlobUrlToRevoke);
        sharedBlobUrlToRevoke = null;
    }

    const translationSection = document.getElementById('translationSection');
    if (translationSection) translationSection.style.display = 'none';
}

// === Translation ===
function parseSRT(content) {
    return content.trim().split(/\n\n+/).map(block => {
        const lines = block.trim().split('\n');
        return { index: lines[0], timestamp: lines[1] || '', text: lines.slice(2).join('\n') };
    }).filter(b => b.timestamp.includes('-->'));
}

async function googleTranslateText(text, targetLang) {
    if (!text.trim()) return text;
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${encodeURIComponent(targetLang)}&dt=t&q=${encodeURIComponent(text)}`;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    return data[0].map(s => s[0]).join('');
}

async function translateWithGoogle(targetLang) {
    const blocks = parseSRT(currentSrtContent);
    if (!blocks.length) throw new Error('No subtitle blocks found');

    const statusEl = document.getElementById('googleTranslateStatus');
    const BATCH = 10;
    const translatedTexts = [];

    for (let i = 0; i < blocks.length; i += BATCH) {
        const slice = blocks.slice(i, Math.min(i + BATCH, blocks.length));
        const results = await Promise.all(slice.map(b => googleTranslateText(b.text, targetLang)));
        translatedTexts.push(...results);
        const pct = Math.round(Math.min((i + BATCH) / blocks.length, 1) * 100);
        if (statusEl) statusEl.textContent = `${getTranslation('translation.translating', 'מתרגם...')} ${pct}%`;
    }

    return blocks.map((b, i) => `${b.index}\n${b.timestamp}\n${translatedTexts[i]}`).join('\n\n') + '\n';
}

function buildTranslationPrompt(targetLang) {
    const langNames = {
        he: 'Hebrew', en: 'English', ar: 'Arabic', ru: 'Russian',
        es: 'Spanish', fr: 'French', de: 'German', pt: 'Portuguese',
        'zh-CN': 'Chinese (Simplified)', ja: 'Japanese', tr: 'Turkish'
    };
    const targetName = langNames[targetLang] || targetLang;
    return `You are a professional subtitle translator.
Translate the following SRT subtitle file to ${targetName}.

Rules:
- Preserve the SRT format exactly (line numbers, timestamps, blank lines between blocks)
- Keep names, places and recurring terms consistent throughout
- Do not merge or split subtitle blocks
- Match the original pacing and tone
- Return ONLY the translated SRT content, no explanations

${currentSrtContent}`;
}

// === Event Handlers ===
function setupEventListeners() {
    // File input change
    if (elements.videoFileInput) {
        elements.videoFileInput.addEventListener('change', (event) => {
            console.log("File input changed");
            selectedFile = event.target.files[0];
            
            if (selectedFile) {
                const isReady = transcriber && !isModelLoading;
                elements.startButton.disabled = !isReady;
                
                const statusMsg = isModelLoading ? 
                    getTranslation('status_messages.loading_model', 'טוען מודל...') :
                    getTranslation('status_messages.file_selected', 'קובץ נבחר. לחץ "התחל תמלול"');
                    
                updateStatus(statusMsg);
                hideDownloadSection();
            } else {
                elements.startButton.disabled = true;
                updateStatus(getTranslation('status_messages.please_select', 'אנא בחר קובץ'));
            }
        });
    }
    
    // Start button
    if (elements.startButton) {
        elements.startButton.addEventListener('click', startTranscription);
    }
    
    // Cancel button
    if (elements.cancelButton) {
        elements.cancelButton.addEventListener('click', () => {
            processingCancelled = true;
            updateStatus(getTranslation('cancelling', 'מבטל תהליך...'));
        });
    }
    
    // Copy SRT button
    if (elements.copySrtButton) {
        elements.copySrtButton.addEventListener('click', async () => {
            const originalText = getTranslation('download.copy_content', 'העתק תוכן');
            await copyToClipboard(currentSrtContent, elements.copySrtButton, originalText);
        });
    }
    
    // Copy prompt button
    if (elements.copyPromptButton) {
        elements.copyPromptButton.addEventListener('click', async () => {
            const promptElement = elements.promptTextElement;
            if (!promptElement) {
                alert(getTranslation('errors.prompt_element_not_found', 'שגיאה: לא נמצא אלמנט טקסט ההנחיה'));
                return;
            }
            
            const promptText = promptElement.textContent || '';
            if (!promptText) {
                alert(getTranslation('errors.empty_prompt', 'שגיאה: טקסט ההנחיה ריק'));
                return;
            }
            
            const originalText = getTranslation('download.copy_prompt', 'העתק הנחיה');
            await copyToClipboard(promptText, elements.copyPromptButton, originalText);
        });
    }
    
    // Google Translate button
    const translateGoogleBtn = document.getElementById('translateGoogleBtn');
    if (translateGoogleBtn) {
        translateGoogleBtn.addEventListener('click', async () => {
            const targetLang = document.getElementById('targetLangSelect')?.value;
            if (!targetLang) return;

            const statusEl = document.getElementById('googleTranslateStatus');
            const dlLink = document.getElementById('downloadTranslatedSrtLink');
            const aiPanel = document.getElementById('aiTranslationPanel');

            if (aiPanel) aiPanel.style.display = 'none';
            if (dlLink) dlLink.style.display = 'none';
            if (statusEl) { statusEl.style.display = 'block'; statusEl.textContent = getTranslation('translation.translating', 'מתרגם...'); }
            translateGoogleBtn.disabled = true;

            try {
                const translated = await translateWithGoogle(targetLang);
                const fileNameBase = selectedFile?.name.substring(0, selectedFile.name.lastIndexOf('.')) || 'subtitles';
                const blob = new Blob([translated], { type: 'text/plain;charset=utf-8' });
                if (dlLink) {
                    dlLink.href = URL.createObjectURL(blob);
                    dlLink.download = `${fileNameBase}_${targetLang}.srt`;
                    dlLink.style.display = 'inline-block';
                }
                if (statusEl) statusEl.textContent = getTranslation('translation.translation_done', 'התרגום הושלם! ✓');
            } catch (err) {
                if (statusEl) statusEl.textContent = `${getTranslation('translation.translation_error', 'שגיאה בתרגום')}: ${err.message}`;
            } finally {
                translateGoogleBtn.disabled = false;
            }
        });
    }

    // AI Translate toggle button
    const translateAiBtn = document.getElementById('translateAiBtn');
    if (translateAiBtn) {
        translateAiBtn.addEventListener('click', () => {
            const aiPanel = document.getElementById('aiTranslationPanel');
            const statusEl = document.getElementById('googleTranslateStatus');
            const dlLink = document.getElementById('downloadTranslatedSrtLink');
            if (statusEl) statusEl.style.display = 'none';
            if (dlLink) dlLink.style.display = 'none';
            if (aiPanel) aiPanel.style.display = aiPanel.style.display === 'none' ? 'block' : 'none';
        });
    }

    // Open AI service buttons
    const aiServiceUrls = {
        openClaudeBtn: 'https://claude.ai',
        openGeminiBtn: 'https://gemini.google.com',
        openChatgptBtn: 'https://chatgpt.com'
    };
    Object.entries(aiServiceUrls).forEach(([id, url]) => {
        const btn = document.getElementById(id);
        if (btn) btn.addEventListener('click', () => window.open(url, '_blank'));
    });

    // Copy translation prompt button
    const copyTranslationPromptBtn = document.getElementById('copyTranslationPromptBtn');
    if (copyTranslationPromptBtn) {
        copyTranslationPromptBtn.addEventListener('click', async () => {
            const targetLang = document.getElementById('targetLangSelect')?.value || 'en';
            const prompt = buildTranslationPrompt(targetLang);
            const originalText = getTranslation('translation.copy_prompt', '📋 העתק פרומפט');
            await copyToClipboard(prompt, copyTranslationPromptBtn, originalText);
        });
    }

    // AI response textarea — show download link when content is pasted
    const aiResponseTextarea = document.getElementById('aiResponseTextarea');
    const downloadAiLink = document.getElementById('downloadAiTranslatedLink');
    if (aiResponseTextarea && downloadAiLink) {
        aiResponseTextarea.addEventListener('input', () => {
            const content = aiResponseTextarea.value.trim();
            if (content) {
                const targetLang = document.getElementById('targetLangSelect')?.value || 'translated';
                const fileNameBase = selectedFile?.name.substring(0, selectedFile.name.lastIndexOf('.')) || 'subtitles';
                const blob = new Blob([aiResponseTextarea.value], { type: 'text/plain;charset=utf-8' });
                downloadAiLink.href = URL.createObjectURL(blob);
                downloadAiLink.download = `${fileNameBase}_${targetLang}.srt`;
                downloadAiLink.style.display = 'inline-block';
            } else {
                downloadAiLink.style.display = 'none';
            }
        });
    }

    // Language switcher
    document.querySelectorAll('.lang-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            const newLang = e.target.getAttribute('data-lang');
            if (newLang && newLang !== currentLanguage) {
                await switchLanguage(newLang);
            }
        });
    });
}

// === Language Switching ===
async function switchLanguage(lang) {
    // Update active button
    document.querySelectorAll('.lang-btn').forEach(btn => {
        btn.classList.toggle('active', btn.getAttribute('data-lang') === lang);
    });
    
    currentLanguage = lang;
    translations = await loadTranslations(lang);
    updateTranslations();
    
    // Save preference
    try {
        localStorage.setItem('preferred-language', lang);
    } catch (e) {
        console.warn('Could not save language preference:', e);
    }
}

// === Initialization ===
async function initializeApp() {
    console.log("Initializing app...");
    
    // Get element references
    elements = {
        videoFileInput: document.getElementById('videoFile'),
        languageSelect: document.getElementById('languageSelect'),
        startButton: document.getElementById('startButton'),
        cancelButton: document.getElementById('cancelButton'),
        status: document.getElementById('status'),
        currentStage: document.getElementById('currentStage'),
        progressPercentage: document.getElementById('progressPercentage'),
        progressBarFill: document.getElementById('progressBarFill'),
        progressDetails: document.getElementById('progressDetails'),
        estimatedTime: document.getElementById('estimatedTime'),
        downloadButtons: document.getElementById('downloadButtons'),
        downloadLinkSrt: document.getElementById('downloadLinkSrt'),
        downloadLinkTxt: document.getElementById('downloadLinkTxt'),
        copySrtButton: document.getElementById('copySrtButton'),
        copyPromptButton: document.getElementById('copyPromptButton'),
        promptTextElement: document.getElementById('promptTextElement')
    };
    
    // Check for missing elements
    const missingElements = Object.entries(elements)
        .filter(([key, element]) => !element)
        .map(([key]) => key);
        
    if (missingElements.length > 0) {
        console.error("Missing elements:", missingElements);
        alert(getTranslation('errors.critical_error', 'שגיאה קריטית: רכיבי דף חסרים'));
        return;
    }
    
    console.log("All elements found");
    
    // Load saved language preference
    let savedLang = 'he';
    try {
        savedLang = localStorage.getItem('preferred-language') || 'he';
    } catch (e) {
        console.warn('Could not load language preference:', e);
    }
    
    // Initialize language
    await switchLanguage(savedLang);
    
    // Setup event listeners
    setupEventListeners();

    // Request notification permission for completion alerts
    if ('Notification' in window && Notification.permission === 'default') {
        Notification.requestPermission();
    }

    // Initialize UI state
    setControlsState(false);
    elements.startButton.disabled = true;
    updateStatus(getTranslation('status_messages.select_file', 'אנא בחר קובץ ובחר שפה'));
    
    console.log("App initialization complete");
    
    // Start loading model in background
    setTimeout(() => {
        if (!isModelLoading && !transcriber) {
            loadTranscriptionModel();
        }
    }, 1000);
}

// === DOM Ready ===
document.addEventListener('DOMContentLoaded', initializeApp);