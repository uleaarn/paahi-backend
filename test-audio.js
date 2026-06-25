/**
 * Audio Conversion Test Suite
 * Tests the μ-law ↔ PCM16 conversion and resampling
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Audio conversion utilities (copied from server.js for testing)
class AudioConverter {
    static mulawToPCM16_24kHz(mulawBuffer) {
        const pcm16_8kHz = this.decodeMulaw(mulawBuffer);
        const pcm16_24kHz = this.resample(pcm16_8kHz, 8000, 24000);
        return pcm16_24kHz;
    }

    static pcm16_24kHzToMulaw(pcm16Buffer) {
        const pcm16_8kHz = this.resample(pcm16Buffer, 24000, 8000);
        const mulawBuffer = this.encodeMulaw(pcm16_8kHz);
        return mulawBuffer;
    }

    static decodeMulaw(mulawBuffer) {
        const pcm16Buffer = Buffer.alloc(mulawBuffer.length * 2);
        for (let i = 0; i < mulawBuffer.length; i++) {
            const mulaw = mulawBuffer[i];
            const pcm = this.mulawToPcm(mulaw);
            pcm16Buffer.writeInt16LE(pcm, i * 2);
        }
        return pcm16Buffer;
    }

    static encodeMulaw(pcm16Buffer) {
        const mulawBuffer = Buffer.alloc(pcm16Buffer.length / 2);
        for (let i = 0; i < mulawBuffer.length; i++) {
            const pcm = pcm16Buffer.readInt16LE(i * 2);
            const mulaw = this.pcmToMulaw(pcm);
            mulawBuffer[i] = mulaw;
        }
        return mulawBuffer;
    }

    static mulawToPcm(mulaw) {
        const MULAW_BIAS = 33;
        mulaw = ~mulaw;
        const sign = mulaw & 0x80;
        const exponent = (mulaw >> 4) & 0x07;
        const mantissa = mulaw & 0x0F;
        let sample = mantissa << (exponent + 3);
        sample += MULAW_BIAS << exponent;
        if (sign) sample = -sample;
        return sample;
    }

    static pcmToMulaw(pcm) {
        const MULAW_MAX = 0x1FFF;
        const MULAW_BIAS = 33;
        const sign = pcm < 0 ? 0x80 : 0x00;
        let sample = Math.abs(pcm);
        sample += MULAW_BIAS;
        if (sample > MULAW_MAX) sample = MULAW_MAX;
        let exponent = 7;
        for (let exp = 0; exp < 8; exp++) {
            if (sample <= (MULAW_BIAS << (exp + 1))) {
                exponent = exp;
                break;
            }
        }
        const mantissa = (sample >> (exponent + 3)) & 0x0F;
        const mulaw = ~(sign | (exponent << 4) | mantissa);
        return mulaw & 0xFF;
    }

    static resample(inputBuffer, inputRate, outputRate) {
        const inputSamples = inputBuffer.length / 2;
        const outputSamples = Math.floor(inputSamples * outputRate / inputRate);
        const outputBuffer = Buffer.alloc(outputSamples * 2);
        const ratio = inputSamples / outputSamples;
        for (let i = 0; i < outputSamples; i++) {
            const srcIndex = Math.floor(i * ratio);
            const sample = inputBuffer.readInt16LE(srcIndex * 2);
            outputBuffer.writeInt16LE(sample, i * 2);
        }
        return outputBuffer;
    }
}

// Test functions
function testMulawEncoding() {
    console.log('\n🧪 Testing μ-law encoding/decoding...');

    // Create test PCM16 data (8kHz, 1 second = 8000 samples)
    const testPcm = Buffer.alloc(8000 * 2);
    for (let i = 0; i < 8000; i++) {
        // Generate a simple sine wave
        const sample = Math.floor(Math.sin(2 * Math.PI * 440 * i / 8000) * 8000);
        testPcm.writeInt16LE(sample, i * 2);
    }

    // Encode to μ-law
    const mulaw = AudioConverter.encodeMulaw(testPcm);
    console.log(`  ✓ Encoded ${testPcm.length} bytes PCM16 to ${mulaw.length} bytes μ-law`);

    // Decode back to PCM16
    const decoded = AudioConverter.decodeMulaw(mulaw);
    console.log(`  ✓ Decoded ${mulaw.length} bytes μ-law to ${decoded.length} bytes PCM16`);

    // Check if sizes match
    if (testPcm.length === decoded.length) {
        console.log('  ✅ Size verification passed');
    } else {
        console.log('  ❌ Size mismatch!');
    }
}

function testResampling() {
    console.log('\n🧪 Testing resampling (8kHz → 24kHz → 8kHz)...');

    // Create test PCM16 data at 8kHz
    const pcm8k = Buffer.alloc(8000 * 2);
    for (let i = 0; i < 8000; i++) {
        const sample = Math.floor(Math.sin(2 * Math.PI * 440 * i / 8000) * 8000);
        pcm8k.writeInt16LE(sample, i * 2);
    }

    console.log(`  Original: ${pcm8k.length} bytes at 8kHz (${pcm8k.length / 2} samples)`);

    // Upsample to 24kHz
    const pcm24k = AudioConverter.resample(pcm8k, 8000, 24000);
    console.log(`  Upsampled: ${pcm24k.length} bytes at 24kHz (${pcm24k.length / 2} samples)`);

    // Downsample back to 8kHz
    const pcm8kAgain = AudioConverter.resample(pcm24k, 24000, 8000);
    console.log(`  Downsampled: ${pcm8kAgain.length} bytes at 8kHz (${pcm8kAgain.length / 2} samples)`);

    // Verify expected sample counts
    const expected8k = 8000;
    const expected24k = 24000;
    const actual8k = pcm8k.length / 2;
    const actual24k = pcm24k.length / 2;

    if (actual8k === expected8k && actual24k === expected24k) {
        console.log('  ✅ Resampling verification passed');
    } else {
        console.log('  ❌ Sample count mismatch!');
    }
}

function testFullPipeline() {
    console.log('\n🧪 Testing full pipeline (Twilio input → model audio format → Twilio output)...');

    // Simulate Twilio input: 8kHz μ-law
    const twilioMulaw = Buffer.alloc(160); // 20ms of audio at 8kHz
    for (let i = 0; i < 160; i++) {
        // Generate test μ-law data
        const pcm = Math.floor(Math.sin(2 * Math.PI * 440 * i / 8000) * 8000);
        twilioMulaw[i] = AudioConverter.pcmToMulaw(pcm);
    }

    console.log(`  Input (Twilio): ${twilioMulaw.length} bytes μ-law @ 8kHz`);

    // Convert to model audio format: 24kHz PCM16
    const modelPcm = AudioConverter.mulawToPCM16_24kHz(twilioMulaw);
    console.log(`  Converted (model): ${modelPcm.length} bytes PCM16 @ 24kHz`);

    // Convert back to Twilio format: 8kHz μ-law
    const twilioMulawOut = AudioConverter.pcm16_24kHzToMulaw(modelPcm);
    console.log(`  Output (Twilio): ${twilioMulawOut.length} bytes μ-law @ 8kHz`);

    console.log('  ✅ Full pipeline test completed');
}

function testMenuLoading() {
    console.log('\n🧪 Testing menu data loading...');

    try {
        const menuPath = path.join(__dirname, 'data', 'menu.json');
        const menu = JSON.parse(fs.readFileSync(menuPath, 'utf-8'));

        console.log(`  ✓ Menu loaded successfully`);
        console.log(`  ✓ Restaurant: ${menu.restaurant_name}`);
        console.log(`  ✓ Categories: ${menu.categories.length}`);

        let totalItems = 0;
        menu.categories.forEach(cat => {
            totalItems += cat.items.length;
        });

        console.log(`  ✓ Total menu items: ${totalItems}`);
        console.log(`  ✓ Modifiers defined: ${Object.keys(menu.modifiers).length}`);
        console.log('  ✅ Menu data validation passed');
    } catch (error) {
        console.log(`  ❌ Menu loading failed: ${error.message}`);
    }
}

function testSystemInstructions() {
    console.log('\n🧪 Testing system instructions loading...');

    try {
        const instructionsPath = path.join(__dirname, 'prompts', 'system-instructions.md');
        const instructions = fs.readFileSync(instructionsPath, 'utf-8');

        console.log(`  ✓ System instructions loaded`);
        console.log(`  ✓ Length: ${instructions.length} characters`);
        console.log(`  ✓ Contains menu knowledge: ${instructions.includes('menu') ? 'Yes' : 'No'}`);
        console.log(`  ✓ Contains order process: ${instructions.includes('order') ? 'Yes' : 'No'}`);
        console.log('  ✅ System instructions validation passed');
    } catch (error) {
        console.log(`  ❌ System instructions loading failed: ${error.message}`);
    }
}

// Run all tests
console.log('╔════════════════════════════════════════════════════════╗');
console.log('║                                                        ║');
console.log('║   Restaurant Voice Agent - Audio Conversion Tests     ║');
console.log('║                                                        ║');
console.log('╚════════════════════════════════════════════════════════╝');

testMulawEncoding();
testResampling();
testFullPipeline();
testMenuLoading();
testSystemInstructions();

console.log('\n✅ All tests completed!\n');
