#!/usr/bin/env node

/**
 * Audio Sanity Test Script
 * 
 * Purpose: Save raw μ-law bytes sent to Twilio, decode locally, and listen
 * If it buzzes locally, the data is wrong BEFORE Twilio
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import mulaw from 'alawmulaw';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Test data directory
const TEST_DIR = path.join(__dirname, 'audio-tests');
if (!fs.existsSync(TEST_DIR)) {
    fs.mkdirSync(TEST_DIR, { recursive: true });
}

/**
 * Save raw μ-law buffer to file
 */
function saveMulawRaw(mulawBuffer, filename) {
    const filepath = path.join(TEST_DIR, filename);
    fs.writeFileSync(filepath, mulawBuffer);
    console.log(`✅ Saved raw μ-law: ${filepath} (${mulawBuffer.length} bytes)`);
    return filepath;
}

/**
 * Decode μ-law to PCM16 and save as WAV
 */
function decodeMulawToWav(mulawBuffer, filename) {
    // Decode μ-law to PCM16
    const mulawUint8 = new Uint8Array(mulawBuffer);
    const pcm16Int16 = mulaw.mulaw.decode(mulawUint8);

    // Convert Int16Array to Buffer
    const pcm16Buffer = Buffer.from(pcm16Int16.buffer);

    // Create WAV file with header
    const sampleRate = 8000;
    const numChannels = 1;
    const bitsPerSample = 16;
    const byteRate = sampleRate * numChannels * bitsPerSample / 8;
    const blockAlign = numChannels * bitsPerSample / 8;
    const dataSize = pcm16Buffer.length;

    // WAV header (44 bytes)
    const header = Buffer.alloc(44);

    // RIFF chunk descriptor
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + dataSize, 4); // File size - 8
    header.write('WAVE', 8);

    // fmt sub-chunk
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16); // Subchunk1Size (16 for PCM)
    header.writeUInt16LE(1, 20); // AudioFormat (1 for PCM)
    header.writeUInt16LE(numChannels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(bitsPerSample, 34);

    // data sub-chunk
    header.write('data', 36);
    header.writeUInt32LE(dataSize, 40);

    // Combine header and PCM data
    const wavBuffer = Buffer.concat([header, pcm16Buffer]);

    const filepath = path.join(TEST_DIR, filename);
    fs.writeFileSync(filepath, wavBuffer);
    console.log(`✅ Saved decoded WAV: ${filepath} (${wavBuffer.length} bytes)`);
    console.log(`   - Sample Rate: ${sampleRate} Hz`);
    console.log(`   - Channels: ${numChannels}`);
    console.log(`   - Bit Depth: ${bitsPerSample}-bit`);
    console.log(`   - Duration: ${(pcm16Buffer.length / 2 / sampleRate).toFixed(2)}s`);

    return filepath;
}

/**
 * Analyze μ-law buffer for anomalies
 */
function analyzeMulaw(mulawBuffer) {
    console.log(`\n🔍 μ-law Buffer Analysis:`);
    console.log(`   - Total bytes: ${mulawBuffer.length}`);

    // Check for WAV header
    if (mulawBuffer.length >= 4) {
        const first4 = mulawBuffer.toString('ascii', 0, 4);
        if (first4 === 'RIFF') {
            console.log(`   ⚠️  WAV HEADER DETECTED: ${first4}`);
        } else {
            console.log(`   ✅ No WAV header (first 4 bytes: ${mulawBuffer.slice(0, 4).toString('hex')})`);
        }
    }

    // Show first 32 bytes in hex
    const preview = mulawBuffer.slice(0, Math.min(32, mulawBuffer.length));
    console.log(`   - First 32 bytes (hex): ${preview.toString('hex')}`);

    // Check for silence (0xFF is μ-law silence)
    const silenceCount = mulawBuffer.filter(b => b === 0xFF).length;
    const silencePercent = (silenceCount / mulawBuffer.length * 100).toFixed(2);
    console.log(`   - Silence bytes (0xFF): ${silenceCount} (${silencePercent}%)`);

    // Value distribution
    const valueSet = new Set(mulawBuffer);
    console.log(`   - Unique values: ${valueSet.size}/256`);
}

/**
 * Test with sample μ-law data
 */
function runTest() {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`🧪 Audio Sanity Test`);
    console.log(`${'='.repeat(60)}\n`);

    // Generate test μ-law data (1 second of 440Hz tone)
    const sampleRate = 8000;
    const duration = 1.0; // seconds
    const frequency = 440; // Hz (A4 note)
    const numSamples = Math.floor(sampleRate * duration);

    // Generate PCM16 sine wave
    const pcm16 = new Int16Array(numSamples);
    for (let i = 0; i < numSamples; i++) {
        const t = i / sampleRate;
        const sample = Math.sin(2 * Math.PI * frequency * t) * 16000; // Amplitude
        pcm16[i] = Math.round(sample);
    }

    // Encode to μ-law
    const mulawTest = mulaw.mulaw.encode(pcm16);
    const mulawBuffer = Buffer.from(mulawTest);

    console.log(`📊 Generated test tone:`);
    console.log(`   - Frequency: ${frequency} Hz`);
    console.log(`   - Duration: ${duration}s`);
    console.log(`   - Samples: ${numSamples}`);
    console.log(`   - μ-law bytes: ${mulawBuffer.length}\n`);

    // Save raw μ-law
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const rawPath = saveMulawRaw(mulawBuffer, `test-${timestamp}.ulaw`);

    // Analyze
    analyzeMulaw(mulawBuffer);

    // Decode and save as WAV
    const wavPath = decodeMulawToWav(mulawBuffer, `test-${timestamp}.wav`);

    console.log(`\n${'='.repeat(60)}`);
    console.log(`✅ Test complete!`);
    console.log(`${'='.repeat(60)}`);
    console.log(`\n📁 Files saved to: ${TEST_DIR}`);
    console.log(`\n🎧 Listen to: ${path.basename(wavPath)}`);
    console.log(`   If it sounds clean, μ-law encoding is working.`);
    console.log(`   If it buzzes, there's a problem with the encoding.\n`);
}

// Export functions for use in server
export { saveMulawRaw, decodeMulawToWav, analyzeMulaw };

// Run test if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
    runTest();
}
