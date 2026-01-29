import { GoogleGenerativeAI } from '@google/generative-ai';
import dotenv from 'dotenv';

dotenv.config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const modelsToTest = [
    'gemini-pro',
    'gemini-1.0-pro',
    'gemini-1.5-pro',
    'gemini-1.5-flash',
    'gemini-1.5-flash-latest',
    'gemini-2.0-flash-exp',
    'models/gemini-pro',
    'models/gemini-1.5-flash',
    'models/gemini-1.5-pro',
];

async function testModel(modelName) {
    try {
        console.log(`\n🧪 Testing: ${modelName}`);
        const model = genAI.getGenerativeModel({ model: modelName });
        const result = await model.generateContent("Say 'Hello' in one word");
        const response = await result.response;
        const text = response.text();
        console.log(`   ✅ SUCCESS! Response: "${text.trim()}"`);
        return true;
    } catch (error) {
        console.log(`   ❌ FAILED: ${error.message.split('\n')[0]}`);
        return false;
    }
}

async function findWorkingModel() {
    console.log('🔍 Testing Gemini models to find one that works...\n');
    console.log('='.repeat(60));

    for (const modelName of modelsToTest) {
        const works = await testModel(modelName);
        if (works) {
            console.log(`\n\n🎉 FOUND WORKING MODEL: ${modelName}`);
            console.log('='.repeat(60));
            return;
        }
        // Small delay between tests
        await new Promise(resolve => setTimeout(resolve, 500));
    }

    console.log('\n\n❌ No working models found!');
    console.log('This suggests the API key may not have access to Gemini models.');
}

findWorkingModel();
