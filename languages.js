/**
 * Language registry: what each language needs end to end, and the fixed
 * phrases Paahi's code speaks itself (readbacks, confirmations, goodbyes).
 *
 * Status is deliberately conservative:
 *   pilot         - full call flow implemented and covered by offline tests;
 *                   still needs live phone calls before customers rely on it.
 *   experimental  - recognition, voice and phrases are wired, but the phrases
 *                   need native-speaker review and nothing has been tested on
 *                   a live call. Businesses must opt in explicitly.
 * Nothing here is marked "supported" until live calls prove it.
 *
 * Provider facts (checked against Deepgram and Google Cloud docs, Nov 2026):
 *   - Deepgram nova-3 transcribes en, es, fr, hi, te; nova-2 has no Telugu.
 *   - nova-3 language=multi covers all five and tags each word's language.
 *   - Google TTS has en-US/es-US/fr-FR/hi-IN Neural2 voices; te-IN has
 *     Standard and Chirp3-HD voices only.
 */

export const LANGUAGES = {
    en: {
        name: 'English', native: 'English', status: 'pilot',
        stt: 'en', tts: { languageCode: 'en-US', voice: 'en-US-Neural2-D' },
    },
    es: {
        name: 'Spanish', native: 'Español', status: 'experimental',
        stt: 'es', tts: { languageCode: 'es-US', voice: 'es-US-Neural2-A' },
    },
    fr: {
        name: 'French', native: 'Français', status: 'experimental',
        stt: 'fr', tts: { languageCode: 'fr-FR', voice: 'fr-FR-Neural2-F' },
    },
    hi: {
        name: 'Hindi', native: 'हिन्दी', status: 'experimental',
        // Male voice: the Hindi phrases below use masculine first-person verbs.
        stt: 'hi', tts: { languageCode: 'hi-IN', voice: 'hi-IN-Neural2-B' },
    },
    te: {
        name: 'Telugu', native: 'తెలుగు', status: 'experimental',
        stt: 'te', tts: { languageCode: 'te-IN', voice: 'te-IN-Standard-A' },
    },
};

export function isKnownLanguage(code) {
    return Object.prototype.hasOwnProperty.call(LANGUAGES, code);
}

// ---------------------------------------------------------------------------
// Fixed phrases. Menu item names, prices and phone digits are inserted as-is.
// Non-English phrases are drafts that need native-speaker review.
// ---------------------------------------------------------------------------

const NUM_WORDS_EN = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];

function amount(n, word) {
    const v = Number.isInteger(n) ? String(n) : n.toFixed(2);
    return `${v} ${word}`;
}

const PHRASES = {
    en: {
        qty: n => NUM_WORDS_EN[n] || String(n),
        spice: { mild: 'mild', extra_spicy: 'extra spicy' },
        allergyNote: 'allergy note',
        money: n => `$${n.toFixed(2)}`,
        orderType: { pickup: 'pickup', delivery: 'delivery' },
        readback: r => [
            `Let me read that back. A ${r.type} order for ${r.name}: ${r.items}.`,
            r.notes && `Note: ${r.notes}.`,
            r.allergy && `Allergy note for the kitchen: ${r.allergy}.`,
            r.address && `Delivering to ${r.address}.`,
            `Your subtotal is ${r.subtotal} before tax.`,
            `And your callback number is ${r.phone}.`,
            'Is everything correct?',
        ],
        greeting: (biz, agent) => `Thank you for calling ${biz}. This is ${agent}. How can I help you today?`,
        languageOffer: names => `You can also speak with me in ${names}.`,
        orderPlaced: (name, biz) => `Perfect, your order is in. Thank you, ${name}. We'll see you at ${biz}. Goodbye!`,
        callbackSent: phone => `I'm sorry about that. I've asked our team to call you back at ${phone} shortly. Thank you for your patience. Goodbye.`,
        cannotFinish: (biz, phone) => `I'm sorry, I'm not able to finish this by phone right now. Please call ${biz} back in a few minutes${phone ? ` at ${phone}` : ''}. Goodbye.`,
        askCallbackNumber: "I'd be glad to have someone from our team call you. What's the best number to reach you?",
        goodbye: biz => `Thank you for calling ${biz}. Have a wonderful day. Goodbye!`,
        alreadyDone: 'Thank you for calling. Goodbye!',
        sayAgain: "Sorry, I didn't catch that. Could you say it again?",
        sayOnceMore: 'Sorry, could you say that once more?',
    },
    es: {
        qty: n => String(n),
        spice: { mild: 'suave', extra_spicy: 'extra picante' },
        allergyNote: 'nota de alergia',
        money: n => amount(n, 'dólares'),
        orderType: { pickup: 'para recoger', delivery: 'a domicilio' },
        readback: r => [
            `Le confirmo su pedido ${r.type} a nombre de ${r.name}: ${r.items}.`,
            r.notes && `Nota: ${r.notes}.`,
            r.allergy && `Nota de alergia para la cocina: ${r.allergy}.`,
            r.address && `Entrega en ${r.address}.`,
            `El subtotal es ${r.subtotal}, sin impuestos.`,
            `Su número de contacto es ${r.phone}.`,
            '¿Está todo correcto?',
        ],
        greeting: (biz, agent) => `Gracias por llamar a ${biz}. Le atiende ${agent}. ¿En qué puedo ayudarle?`,
        languageOffer: names => `También puede hablar conmigo en ${names}.`,
        orderPlaced: (name, biz) => `Perfecto, su pedido está hecho. Gracias, ${name}. Le esperamos en ${biz}. ¡Hasta luego!`,
        callbackSent: phone => `Lo siento. Le pedí a nuestro equipo que le llame al ${phone} en breve. Gracias por su paciencia. Adiós.`,
        cannotFinish: (biz, phone) => `Lo siento, ahora mismo no puedo completar esto por teléfono. Por favor, llame a ${biz} en unos minutos${phone ? ` al ${phone}` : ''}. Adiós.`,
        askCallbackNumber: 'Con gusto le llamará alguien de nuestro equipo. ¿A qué número le podemos llamar?',
        goodbye: biz => `Gracias por llamar a ${biz}. ¡Que tenga un buen día!`,
        alreadyDone: 'Gracias por llamar. ¡Adiós!',
        sayAgain: 'Perdón, no le entendí. ¿Puede repetirlo?',
        sayOnceMore: 'Perdón, ¿puede repetirlo una vez más?',
    },
    fr: {
        qty: n => String(n),
        spice: { mild: 'doux', extra_spicy: 'très épicé' },
        allergyNote: 'allergie',
        money: n => amount(n, 'dollars'),
        orderType: { pickup: 'à emporter', delivery: 'en livraison' },
        readback: r => [
            `Je vous relis la commande ${r.type} au nom de ${r.name} : ${r.items}.`,
            r.notes && `Remarque : ${r.notes}.`,
            r.allergy && `Allergie signalée à la cuisine : ${r.allergy}.`,
            r.address && `Livraison au ${r.address}.`,
            `Le sous-total est de ${r.subtotal}, hors taxes.`,
            `Votre numéro de rappel est le ${r.phone}.`,
            'Est-ce que tout est correct ?',
        ],
        greeting: (biz, agent) => `Merci d'avoir appelé ${biz}. Ici ${agent}. Comment puis-je vous aider ?`,
        languageOffer: names => `Vous pouvez aussi me parler en ${names}.`,
        orderPlaced: (name, biz) => `Parfait, votre commande est enregistrée. Merci, ${name}. À bientôt chez ${biz}. Au revoir !`,
        callbackSent: phone => `Toutes mes excuses. J'ai demandé à notre équipe de vous rappeler au ${phone} très bientôt. Merci de votre patience. Au revoir.`,
        cannotFinish: (biz, phone) => `Toutes mes excuses, je ne peux pas terminer cela par téléphone pour le moment. Merci de rappeler ${biz} dans quelques minutes${phone ? ` au ${phone}` : ''}. Au revoir.`,
        askCallbackNumber: "Avec plaisir, quelqu'un de notre équipe vous rappellera. À quel numéro pouvons-nous vous joindre ?",
        goodbye: biz => `Merci d'avoir appelé ${biz}. Bonne journée, au revoir !`,
        alreadyDone: "Merci d'avoir appelé. Au revoir !",
        sayAgain: "Pardon, je n'ai pas bien compris. Pouvez-vous répéter ?",
        sayOnceMore: 'Pardon, pouvez-vous répéter encore une fois ?',
    },
    hi: {
        qty: n => String(n),
        spice: { mild: 'कम तीखा', extra_spicy: 'ज़्यादा तीखा' },
        allergyNote: 'एलर्जी नोट',
        money: n => amount(n, 'डॉलर'),
        orderType: { pickup: 'पिकअप', delivery: 'डिलीवरी' },
        readback: r => [
            `मैं आपका ऑर्डर दोहरा देता हूँ। ${r.name} के नाम पर ${r.type} ऑर्डर: ${r.items}।`,
            r.notes && `नोट: ${r.notes}।`,
            r.allergy && `किचन के लिए एलर्जी नोट: ${r.allergy}।`,
            r.address && `डिलीवरी का पता: ${r.address}।`,
            `टैक्स से पहले कुल ${r.subtotal} है।`,
            `आपका कॉलबैक नंबर ${r.phone} है।`,
            'क्या सब कुछ सही है?',
        ],
        greeting: (biz, agent) => `${biz} में कॉल करने के लिए धन्यवाद। मैं ${agent} बोल रहा हूँ। मैं आपकी क्या मदद कर सकता हूँ?`,
        languageOffer: names => `आप मुझसे ${names} में भी बात कर सकते हैं।`,
        orderPlaced: (name, biz) => `बढ़िया, आपका ऑर्डर लग गया है। धन्यवाद, ${name}। ${biz} में आपका इंतज़ार रहेगा। नमस्ते!`,
        callbackSent: phone => `माफ़ कीजिए। मैंने हमारी टीम से कहा है कि वे आपको ${phone} पर जल्द ही कॉल करें। धन्यवाद। नमस्ते।`,
        cannotFinish: (biz, phone) => `माफ़ कीजिए, अभी मैं यह फ़ोन पर पूरा नहीं कर पा रहा हूँ। कृपया कुछ मिनट बाद ${biz} को${phone ? ` ${phone} पर` : ''} दोबारा कॉल करें। नमस्ते।`,
        askCallbackNumber: 'ज़रूर, हमारी टीम से कोई आपको कॉल करेगा। आपसे किस नंबर पर बात हो सकती है?',
        goodbye: biz => `${biz} में कॉल करने के लिए धन्यवाद। आपका दिन शुभ हो। नमस्ते!`,
        alreadyDone: 'कॉल करने के लिए धन्यवाद। नमस्ते!',
        sayAgain: 'माफ़ कीजिए, मैं समझ नहीं पाया। क्या आप दोबारा बोल सकते हैं?',
        sayOnceMore: 'माफ़ कीजिए, क्या आप एक बार और बोल सकते हैं?',
    },
    te: {
        qty: n => String(n),
        spice: { mild: 'తక్కువ కారం', extra_spicy: 'ఎక్కువ కారం' },
        allergyNote: 'అలర్జీ నోట్',
        money: n => amount(n, 'డాలర్లు'),
        orderType: { pickup: 'పికప్', delivery: 'డెలివరీ' },
        readback: r => [
            `మీ ఆర్డర్ ఒకసారి చదువుతాను. ${r.name} పేరు మీద ${r.type} ఆర్డర్: ${r.items}.`,
            r.notes && `నోట్: ${r.notes}.`,
            r.allergy && `వంటగదికి అలర్జీ నోట్: ${r.allergy}.`,
            r.address && `డెలివరీ చిరునామా: ${r.address}.`,
            `టాక్స్ కాకుండా మొత్తం ${r.subtotal}.`,
            `మీ కాల్‌బ్యాక్ నంబర్ ${r.phone}.`,
            'అన్నీ సరిగ్గా ఉన్నాయా?',
        ],
        greeting: (biz, agent) => `${biz} కి కాల్ చేసినందుకు ధన్యవాదాలు. నేను ${agent}. మీకు ఎలా సహాయం చేయగలను?`,
        languageOffer: names => `మీరు నాతో ${names} లో కూడా మాట్లాడవచ్చు.`,
        orderPlaced: (name, biz) => `సరే, మీ ఆర్డర్ నమోదైంది. ధన్యవాదాలు, ${name}. ${biz} లో మీ కోసం ఎదురుచూస్తాం. నమస్కారం!`,
        callbackSent: phone => `క్షమించండి. మా టీమ్ మీకు ${phone} కి త్వరలో కాల్ చేస్తుంది. ధన్యవాదాలు. నమస్కారం.`,
        cannotFinish: (biz, phone) => `క్షమించండి, ఇప్పుడు ఫోన్‌లో ఇది పూర్తి చేయలేకపోతున్నాను. దయచేసి కొన్ని నిమిషాల తర్వాత ${biz} కి${phone ? ` ${phone} కి` : ''} మళ్ళీ కాల్ చేయండి. నమస్కారం.`,
        askCallbackNumber: 'తప్పకుండా, మా టీమ్ నుండి ఎవరైనా మీకు కాల్ చేస్తారు. ఏ నంబర్‌కి కాల్ చేయాలి?',
        goodbye: biz => `${biz} కి కాల్ చేసినందుకు ధన్యవాదాలు. శుభదినం. నమస్కారం!`,
        alreadyDone: 'కాల్ చేసినందుకు ధన్యవాదాలు. నమస్కారం!',
        sayAgain: 'క్షమించండి, నాకు అర్థం కాలేదు. మళ్ళీ చెప్పగలరా?',
        sayOnceMore: 'క్షమించండి, ఇంకొకసారి చెప్పగలరా?',
    },
};

// ---------------------------------------------------------------------------
// Explicit confirmation. A clear "yes" with no "but/change/add/no" in it.
// English words count in every language (callers code-switch: "haan, ok").
// Non-English word lists are drafts that need native-speaker review.
// ---------------------------------------------------------------------------

const CONFIRMATION_WORDS = {
    en: {
        yes: ['yes', 'yeah', 'yea', 'yep', 'yup', 'correct', "that's right", 'thats right', "that's correct", "that's it", "that's all",
            'sounds good', 'sounds right', 'sounds great', 'sounds perfect', 'confirm', 'confirmed', 'go ahead', 'place it',
            'place the order', 'place my order', 'perfect', 'right', 'sure', 'ok', 'okay', 'absolutely', 'definitely',
            'all good', 'looks good', 'exactly'],
        notYet: ['no', 'nope', 'not', "don't", 'dont', 'wait', 'hold on', 'change', 'add', 'remove', 'actually', 'instead',
            'but', 'wrong', 'cancel', 'minus', 'without', 'another', 'more', 'less', 'extra'],
    },
    es: {
        yes: ['sí', 'si', 'correcto', 'claro', 'perfecto', 'exacto', 'de acuerdo', 'está bien', 'esta bien', 'vale', 'así es', 'eso es', 'confirmo'],
        notYet: ['no', 'espere', 'espera', 'cambiar', 'cambie', 'cambia', 'pero', 'además', 'quitar', 'quite', 'agregar', 'agregue',
            'añadir', 'añada', 'otro', 'otra', 'más', 'menos', 'sin', 'cancelar', 'mejor'],
    },
    fr: {
        yes: ['oui', "c'est bon", "c'est ça", "c'est correct", "c'est parfait", 'exactement', 'parfait', "d'accord", 'tout à fait', 'voilà', 'confirmé'],
        notYet: ['non', 'attendez', 'attends', 'changer', 'changez', 'mais', 'ajouter', 'ajoutez', 'enlever', 'enlevez',
            'retirer', 'retirez', 'encore', 'autre', 'plus', 'moins', 'sans', 'annuler', 'plutôt'],
    },
    hi: {
        yes: ['हाँ', 'हां', 'हाँ जी', 'जी हाँ', 'जी', 'ठीक है', 'सही है', 'बिल्कुल', 'हान', 'haan', 'han', 'theek hai', 'sahi hai'],
        notYet: ['नहीं', 'नही', 'रुको', 'रुकिए', 'बदल', 'बदलो', 'बदलिए', 'लेकिन', 'मगर', 'हटा', 'हटाओ', 'जोड़', 'जोड़ो', 'और', 'कम', 'ज़्यादा',
            'nahi', 'nahin', 'lekin', 'aur'],
    },
    te: {
        yes: ['అవును', 'సరే', 'ఓకే', 'కరెక్ట్', 'సరిగ్గా ఉంది', 'సరిగ్గా', 'అంతే', 'avunu', 'sare'],
        notYet: ['కాదు', 'వద్దు', 'ఆగండి', 'ఆగు', 'మార్చ', 'మార్చండి', 'కానీ', 'ఇంకా', 'తీసేయ', 'తీసేయండి', 'కలప', 'కాస్త', 'kaadu', 'vaddu', 'kani'],
    },
};

function wordPattern(list) {
    const escaped = list.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).sort((a, b) => b.length - a.length);
    // Letter-aware boundaries so this works for Devanagari and Telugu too.
    return new RegExp(`(?<![\\p{L}\\p{M}])(${escaped.join('|')})(?![\\p{L}\\p{M}])`, 'iu');
}

const CONFIRMATION_PATTERNS = Object.fromEntries(Object.entries(CONFIRMATION_WORDS).map(([code, w]) => [code, {
    yes: wordPattern(code === 'en' ? w.yes : [...w.yes, ...CONFIRMATION_WORDS.en.yes]),
    notYet: wordPattern(code === 'en' ? w.notYet : [...w.notYet, ...CONFIRMATION_WORDS.en.notYet]),
}]));

/** True only for a clear, unqualified yes in the call language. Anything mixed means "not yet". */
export function isExplicitConfirmation(utterance, language = 'en') {
    const text = String(utterance || '').trim().replace(/[’`]/g, "'");
    if (!text) return false;
    const p = CONFIRMATION_PATTERNS[language] || CONFIRMATION_PATTERNS.en;
    return p.yes.test(text) && !p.notYet.test(text);
}

/** Fixed phrases for a language; falls back to English if a code is unknown. */
export function phrases(code) {
    return PHRASES[code] || PHRASES.en;
}

export function hasPhrases(code) {
    return Boolean(PHRASES[code]);
}
