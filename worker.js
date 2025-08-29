// worker.js - VERSION 4 (WITH DOWNLOAD SPEED CALCULATION)

import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.1/dist/transformers.min.js';

env.remoteHost = 'https://huggingface.co/';
env.allowLocalModels = false;
env.allowRemoteModels = true;
env.backends.onnx.wasm.proxy = true;

const MODEL_NAME = 'Xenova/whisper-tiny.quant';
const TARGET_SAMPLE_RATE = 16000;
const TASK = 'transcribe';
let transcriber = null;

// --- משתנים לחישוב מהירות ההורדה ---
let lastTimestamp = null;
let lastLoadedBytes = 0;

// --- פונקציות עזר (ללא שינוי) ---

function convertToMono(audioBuffer) {
    if (audioBuffer.numberOfChannels === 1) return audioBuffer.getChannelData(0);
    const numChannels = audioBuffer.numberOfChannels, numSamples = audioBuffer.length;
    const mono = new Float32Array(numSamples);
    for (let i = 0; i < numSamples; ++i) {
        let sum = 0;
        for (let j = 0; j < numChannels; ++j) {
            sum += audioBuffer.getChannelData(j)[i];
        }
        mono[i] = sum / numChannels;
    }
    return mono;
}

function formatTimeToSRT(seconds) {
    if (isNaN(seconds) || seconds === null || seconds < 0) return '00:00:00,000';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    const ms = Math.floor((seconds - Math.floor(seconds)) * 1000);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

function chunksToSRT(chunks) {
    let srt = '', index = 1;
    chunks.forEach(chunk => {
        if (chunk.timestamp && typeof chunk.timestamp[0] === 'number' && typeof chunk.timestamp[1] === 'number' && chunk.timestamp[0] <= chunk.timestamp[1] && chunk.text?.trim()) {
            const startTime = formatTimeToSRT(chunk.timestamp[0]);
            const endTime = formatTimeToSRT(chunk.timestamp[1]);
            srt += `${index++}\n${startTime} --> ${endTime}\n${chunk.text.trim()}\n\n`;
        } else {
            console.warn("Skipped invalid chunk:", chunk);
        }
    });
    return srt;
}

async function extractAndResampleAudio(mediaFile) {
    self.postMessage({ status: 'update', textKey: 'statusReadingFile', progress: 0, detail: 'Starting...' });
    
    const fileReader = new FileReader();
    return new Promise(async (resolve, reject) => {
        let audioContext;
        try {
            audioContext = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE });
        } catch (e) {
            return reject(new Error(`Error creating AudioContext: ${e.message}.`));
        }

        fileReader.onprogress = (event) => {
            if (event.lengthComputable) {
                const percentage = (event.loaded / event.total) * 100;
                const detail = `${(event.loaded/1e6).toFixed(1)}MB / ${(event.total/1e6).toFixed(1)}MB`;
                self.postMessage({ status: 'update', textKey: 'statusReadingFile', progress: percentage, detail });
            }
        };

        fileReader.onload = async (event) => {
            try {
                if (!event.target?.result) return reject(new Error("File reading did not return data."));
                self.postMessage({ status: 'update', textKey: 'statusDecodingAudio', progress: null, detail: 'Processing data...' });
                const audioBuffer = await audioContext.decodeAudioData(event.target.result);

                if (audioBuffer.length === 0) return reject(new Error("Audio file is empty."));
                
                let processedBuffer;
                if (audioBuffer.sampleRate !== TARGET_SAMPLE_RATE) {
                    const detail = `From ${audioBuffer.sampleRate}Hz to ${TARGET_SAMPLE_RATE}Hz`;
                    self.postMessage({ status: 'update', textKey: 'statusResampling', progress: null, detail });
                    const offline = new OfflineAudioContext(audioBuffer.numberOfChannels, audioBuffer.duration * TARGET_SAMPLE_RATE, TARGET_SAMPLE_RATE);
                    const source = offline.createBufferSource(); source.buffer = audioBuffer; source.connect(offline.destination); source.start();
                    processedBuffer = await offline.startRendering();
                } else {
                    processedBuffer = audioBuffer;
                }
                
                self.postMessage({ status: 'update', textKey: 'statusConvertToMono', progress: null, detail: '' });
                resolve(convertToMono(processedBuffer));
            } catch (error) {
                reject(new Error(`Audio decoding error: ${error.message}.`));
            } finally {
                if (audioContext?.state !== 'closed') audioContext.close().catch(console.error);
            }
        };
        fileReader.onerror = () => { if (audioContext?.state !== 'closed') audioContext.close().catch(console.error); reject(new Error(`File reading error.`)); }
        fileReader.readAsArrayBuffer(mediaFile);
    });
}


// --- מאזין להודעות מה-UI Thread ---
self.onmessage = async (event) => {
    const { type, data } = event.data;
    try {
        if (type === 'loadModel') {
            if (transcriber) { self.postMessage({ status: 'modelReady' }); return; }
            
            transcriber = await pipeline('automatic-speech-recognition', MODEL_NAME, {
                progress_callback: (p) => {
                    // *** כאן מתבצע חישוב המהירות ***
                    if (p.status === 'downloading') {
                        const currentTime = performance.now();
                        let speedText = '';
                        // ודא שזו לא הפעם הראשונה, כדי שיהיה לנו הפרש זמנים
                        if (lastTimestamp) {
                            const timeDiffSeconds = (currentTime - lastTimestamp) / 1000;
                            const bytesDiff = p.loaded - lastLoadedBytes;
                            if (timeDiffSeconds > 0) {
                                const bytesPerSecond = bytesDiff / timeDiffSeconds;
                                // המר את המהירות ליחידות קריאות (MB/s)
                                speedText = `${(bytesPerSecond / 1024 / 1024).toFixed(2)} MB/s`;
                            }
                        }
                        // שמור את הנתונים הנוכחיים לפעם הבאה
                        lastTimestamp = currentTime;
                        lastLoadedBytes = p.loaded;

                        // שלח את כל המידע, כולל המהירות, ל-UI
                        self.postMessage({ status: 'modelProgress', data: { ...p, speedText } });
                    } else {
                        // אם זה לא סטטוס הורדה, אפס את המשתנים ושלח את המידע הרגיל
                        lastTimestamp = null;
                        lastLoadedBytes = 0;
                        self.postMessage({ status: 'modelProgress', data: p });
                    }
                }
            });
            self.postMessage({ status: 'modelReady' });
        } else if (type === 'transcribe') {
            const { file, language } = data;
            const audioData = await extractAndResampleAudio(file);
            
            const langText = language === 'auto' ? 'auto' : language;
            self.postMessage({ status: 'update', textKey: 'statusTranscribing', detail: `(${langText}) This may take some time...` });

            const output = await transcriber(audioData, {
                chunk_length_s: 30,
                stride_length_s: 5,
                language: language === 'auto' ? undefined : language,
                task: TASK,
                return_timestamps: true,
                progress_callback: (p) => {
                    if (p.status === 'progress' && !p.file) self.postMessage({ status: 'transcriptionProgress', data: p });
                }
            });

            self.postMessage({ status: 'update', textKey: 'statusProcessingResults' });
            const srtContent = chunksToSRT(output.chunks);
            if (!srtContent) throw new Error("SRT creation failed or produced empty result.");
            self.postMessage({ status: 'done', srt: srtContent });
        }
    } catch (error) {
        self.postMessage({ status: 'error', message: error.message });
    }
};