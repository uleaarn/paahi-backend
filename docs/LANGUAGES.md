# Language capability matrix

A language only counts as **supported** once the whole call works in it on live phone calls: recognition, conversation, business terms and voice. **No language has reached that bar yet**, English included, because no live call has been made with this code.

Provider facts were checked against the Deepgram and Google Cloud documentation in November 2026.

| | English `en` | Spanish `es` | French `fr` | Hindi `hi` | Telugu `te` |
|---|---|---|---|---|---|
| **Status in Paahi** | pilot | experimental | experimental | experimental | experimental |
| **Speech recognition** (Deepgram nova-3) | yes | yes | yes | yes | yes (nova-3 only; nova-2 has no Telugu) |
| **Mixed-language calls** (nova-3 `multi`, per-word language tags) | yes | yes | yes | yes | yes |
| **Voice** (Google TTS, default) | `en-US-Neural2-D` | `es-US-Neural2-A` | `fr-FR-Neural2-F` | `hi-IN-Neural2-B` | `te-IN-Standard-A` (no Neural2 exists; Chirp3-HD is untested) |
| **Fixed phrases** (readback, confirmations, goodbyes) | written | draft, needs native review | draft, needs native review | draft, needs native review | draft, needs native review |
| **"Yes" detection** for final confirmation | tested | tested offline, word list needs review | tested offline, word list needs review | tested offline, word list needs review | tested offline, word list needs review |
| **Conversation** (DeepSeek `deepseek-chat`) | expected good | expected good | expected good | not measured | not measured; likely the weakest |
| **Menu names, prices, numbers** | kept as-is | kept as-is | kept as-is | kept as-is (English names spoken by the Hindi voice: untested) | kept as-is (untested) |
| **Live phone call tested** | no | no | no | no | no |

## How languages work in a call

- Each business lists its languages in `business.json` (`languages.enabled`, `languages.default`). Experimental languages need `"allow_experimental": true`, so nobody turns one on for real customers by accident.
- **One language:** Deepgram listens in that language only (nova-3 by default).
- **More than one language:** Deepgram runs nova-3 with `language=multi`, hinted with the business's languages and `endpointing=100`, as Deepgram recommends for mixed-language speech. Each final transcript reports which language most of its words were in. That is passed to the model as a hint.
- The greeting is in the default language and mentions the others. The model calls `set_language` when the caller asks or clearly keeps speaking another enabled language. From then on the model replies in that language, the voice switches, and the fixed phrases switch.
- The order record stays language-neutral: menu item IDs and names exactly as on the menu, spice levels such as `mild`, and digits for phone numbers. Staff always receive the same structured order.

## Known gaps (honest list)

1. **Native-speaker review** of the phrases and "yes" word lists in `languages.js` for es, fr, hi and te. The Hindi phrases use masculine verbs, so the default Hindi voice is male (`hi-IN-Neural2-B`). If you change the voice, check the phrasing.
2. **Telugu model quality.** DeepSeek's Telugu hasn't been measured. If it's weak, set `LLM_MODEL` to a stronger model for Telugu businesses. That would need a per-language model setting, which isn't built.
3. **Telugu voice quality.** Only Standard (older) and Chirp3-HD voices exist. Chirp3-HD at an 8 kHz phone sample rate hasn't been tested.
4. **Indian dish names spoken by non-English voices,** and recognized in Hindi or Telugu speech. Deepgram keyterm prompting (nova-3) could help but isn't switched on yet.
5. **Automatic language choice** relies on the model acting on the recognizer's hint. There's no hard rule yet, such as "switch after two utterances in language X".
6. **The fallback when the voice provider is down** is silence. A Twilio `<Say>` fallback per language isn't built.

## Before calling a language "supported"

For each language: 10 or more live test calls by native speakers, covering a full order, a correction after the readback, a "yes, but…" (which must not submit), an allergy question, a request for a person, and noisy audio. Record the results here.
