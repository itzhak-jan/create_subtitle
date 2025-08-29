// transcription-worker.js - Web Worker for heavy processing
// This worker handles audio processing and transcription to prevent UI blocking

importScripts('https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.1/dist/transformers.min.js');

// Worker state
let transcriber = null;
let isModelLoading = false;

// Configuration
const MODEL_NAME = 'Xenova/whisper-tiny';
const TARGET_SAMPLE_RATE = 16000;
const TASK = 'transcribe';

// Configure environment
self.env = {
    allowLocalModels: false,
    allowRemoteModels: true
};

// === Utility Functions ===
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
        }
    });
    
    return srt;
}

// === Progress Callback for Model Loading ===
function modelProgressCallback(data) {
    self.postMessage({
        type: 'modelProgress',
        data: data
    });
}

// === Model Loading ===
async function loadModel() {
    if (transcriber) return transcriber;
    if (isModelLoading) return null;
    
    isModelLoading = true;
    
    try {
        self.postMessage({
            type: 'status',
            status: 'loadingModel',
            message: 'Loading transcription model...'
        });
        
        const { pipeline } = self;
        transcriber = await pipeline('automatic-speech-recognition', MODEL_NAME, {
            progress_callback: modelProgressCallback
        });
        
        isModelLoading = false;
        
        self.postMessage({
            type: 'status',
            status: 'modelReady',
            message: 'Model loaded successfully'
        });
        
        return transcriber;
        
    } catch (error) {
        isModelLoading = false;
        self.postMessage({
            type: 'error',
            error: 'Failed to load model: ' + error.message
        });
        return null;
    }
}

// === Audio Processing ===
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

async function processAudioFile(fileData, fileName) {
    try {
        self.postMessage({
            type: 'progress',
            stage: 'decoding',
            percentage: 0,
            details: 'Decoding audio data...'
        });
        
        // Create audio context in worker
        const audioContext = new (self.AudioContext || self.webkitAudioContext)({
            sampleRate: TARGET_SAMPLE_RATE
        });
        
        // Decode audio data
        const audioBuffer = await audioContext.decodeAudioData(fileData);
        
        if (audioBuffer.length === 0) {
            throw new Error('Audio file is empty');
        }
        
        self.postMessage({
            type: 'progress',
            stage: 'resampling',
            percentage: 30,
            details: 'Processing audio...'
        });
        
        let processedBuffer = audioBuffer;
        
        // Resample if necessary
        if (audioBuffer.sampleRate !== TARGET_SAMPLE_RATE) {
            self.postMessage({
                type: 'progress',
                stage: 'resampling',
                percentage: 50,
                details: `Converting from ${audioBuffer.sampleRate}Hz to ${TARGET_SAMPLE_RATE}Hz`
            });
            
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
        }
        
        self.postMessage({
            type: 'progress',
            stage: 'converting',
            percentage: 70,
            details: 'Converting to mono...'
        });
        
        // Convert to mono
        const monoAudio = convertToMono(processedBuffer);
        
        self.postMessage({
            type: 'progress',
            stage: 'converting',
            percentage: 100,
            details: 'Audio processing complete'
        });
        
        await audioContext.close();
        return monoAudio;
        
    } catch (error) {
        throw new Error('Audio processing failed: ' + error.message);
    }
}

// === Transcription ===
async function performTranscription(audioData, language) {
    try {
        const currentTranscriber = await loadModel();
        if (!currentTranscriber) {
            throw new Error('Model not available');
        }
        
        self.postMessage({
            type: 'progress',
            stage: 'transcribing',
            percentage: 0,
            details: 'Starting transcription...'
        });
        
        const langCode = language === 'auto' ? undefined : language;
        
        const result = await currentTranscriber(audioData, {
            chunk_length_s: 30,
            stride_length_s: 5,
            language: langCode,
            task: TASK,
            return_timestamps: true,
            progress_callback: (progressData) => {
                if (progressData.status === 'progress' && !progressData.file) {
                    self.postMessage({
                        type: 'progress',
                        stage: 'transcribing',
                        percentage: progressData.progress || 0,
                        details: 'Processing audio segments...'
                    });
                }
            }
        });
        
        self.postMessage({
            type: 'progress',
            stage: 'finalizing',
            percentage: 90,
            details: 'Generating subtitle file...'
        });
        
        // Generate SRT
        let srtContent = '';
        if (result?.chunks?.length) {
            srtContent = chunksToSRT(result.chunks);
        } else if (result?.text) {
            // Fallback for single text result
            const duration = audioData.length / TARGET_SAMPLE_RATE;
            const fallbackChunk = {
                timestamp: [0, duration || 1],
                text: result.text
            };
            srtContent = chunksToSRT([fallbackChunk]);
        }
        
        if (!srtContent) {
            throw new Error('No transcription content generated');
        }
        
        self.postMessage({
            type: 'progress',
            stage: 'finalizing',
            percentage: 100,
            details: 'Complete!'
        });
        
        return srtContent;
        
    } catch (error) {
        throw new Error('Transcription failed: ' + error.message);
    }
}

// === Message Handler ===
self.addEventListener('message', async (event) => {
    const { type, data } = event.data;
    
    try {
        switch (type) {
            case 'loadModel':
                await loadModel();
                break;
                
            case 'processFile':
                const { fileData, fileName, language } = data;
                
                // Process audio
                self.postMessage({
                    type: 'status',
                    status: 'processing',
                    message: 'Processing audio file...'
                });
                
                const audioData = await processAudioFile(fileData, fileName);
                
                // Transcribe
                self.postMessage({
                    type: 'status',
                    status: 'transcribing',
                    message: 'Transcribing audio...'
                });
                
                const srtContent = await performTranscription(audioData, language);
                
                // Return result
                self.postMessage({
                    type: 'complete',
                    result: srtContent
                });
                break;
                
            case 'cancel':
                // Handle cancellation
                self.postMessage({
                    type: 'cancelled'
                });
                break;
                
            default:
                console.warn('Unknown message type:', type);
        }
    } catch (error) {
        console.error('Worker error:', error);
        self.postMessage({
            type: 'error',
            error: error.message
        });
    }
});

// Initial model loading
self.postMessage({
    type: 'status',
    status: 'ready',
    message: 'Worker ready'
});

// Load model in background after a delay
setTimeout(() => {
    if (!transcriber && !isModelLoading) {
        loadModel().catch(console.error);
    }
}, 2000);