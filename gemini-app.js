/**
 * gemini-app.js
 *
 * Alternative entry point using Google Generative AI SDK (Gemini) instead of Groq.
 * Same Slack Bolt integration and Strapi tools, different LLM backend.
 *
 * Usage: GEMINI_API_KEY=... node gemini-app.js
 */

require('dotenv').config();

const { App } = require('@slack/bolt');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { executeToolCall } = require('./strapiTools');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const GEMINI_MODEL = 'gemini-2.0-flash';
const MAX_TOOL_ITERATIONS = 10;
const MAX_TOTAL_TOOL_CALLS = 15;

const SYSTEM_PROMPT = `Kamu adalah asisten AI yang membantu mengelola data pada Strapi CMS.
Kamu terhubung ke instance Strapi v4 melalui tool "access_strapi_cms".

Kemampuanmu:
1. Melihat daftar semua Collection Types dan Single Types yang tersedia.
2. Mengambil data (entries) dari collection manapun.
3. Mengambil detail entry tertentu berdasarkan ID.
4. Membuat, mengubah, dan menghapus entry.
5. Membaca dan meringkas isi file PDF yang terlampir pada entry Strapi.

MEMAHAMI BAHASA NATURAL USER:
- User akan bicara secara natural. Mereka TIDAK akan menyebutkan nama teknis API.
- "Venue" = collection "venues", "Artikel" = "articles", "Event" = "events", dll.
- "marketing address" = kemungkinan field "marketingAddress" atau "marketing_address" di Strapi.
- "tengah kota" = kemungkinan bagian dari nama entry → gunakan filter $contains untuk mencari.
- Selalu terjemahkan istilah natural user ke parameter teknis Strapi yang benar.

WORKFLOW MENCARI COLLECTION:
1. SELALU panggil list_collections dengan parameter "search" berisi keyword dari nama yang disebut user.
   Contoh: user bilang "Venue" → list_collections(search="venue").
2. Dari hasilnya, gunakan nilai "route" sebagai parameter "collection".
3. Jika ada beberapa collection yang mirip, tanyakan ke user mana yang dimaksud.
4. Jangan pernah menebak nama collection tanpa memanggil list_collections dulu.

WORKFLOW UPDATE/DELETE (WAJIB IKUTI URUTAN INI):
1. Cari collection: list_collections(search="<keyword>") → dapatkan route.
2. Cari entry: get_entries(collection, filters={"name": {"$contains": "<keyword>"}}) → dapatkan ID numerik DAN lihat nama-nama field yang tersedia di data entry.
3. Cocokkan field: Perhatikan field names dari hasil get_entries. User mungkin bilang "marketing address" tapi field-nya bisa "marketingAddress", "marketing_address", atau "alamat_marketing". Pilih yang paling cocok.
4. Eksekusi: update_entry(collection, entry_id, data={fieldYangBenar: "nilai baru"}).
- JANGAN PERNAH langsung update tanpa get_entries dulu. Kamu butuh ID numerik dan nama field yang benar.

WORKFLOW MEMBUAT ENTRY BARU:
1. Cari collection dulu dengan list_collections.
2. Gunakan get_entries atau get_entry untuk melihat struktur field yang ada.
3. Buat entry dengan create_entry menggunakan field names yang benar dari hasil inspeksi.

ATURAN UMUM:
- Parameter "entry_id" HARUS berupa angka (contoh: "5", "12"). JANGAN PERNAH isi dengan placeholder.
- Untuk mencari entry berdasarkan nama/judul, gunakan filter: {"name": {"$contains": "kata kunci"}} atau {"title": {"$contains": "kata kunci"}}.
- Jika field pencarian tidak pasti antara "name" atau "title", coba "name" dulu. Jika hasilnya kosong, coba "title".
- Jika user meminta ringkasan PDF, gunakan action "read_attachment" lalu ringkas hasilnya.
- Selalu jawab dalam bahasa yang sama dengan bahasa user (Indonesia atau English).
- Berikan jawaban yang ringkas dan informatif.
- Jika terjadi error, jelaskan masalahnya dengan bahasa yang mudah dipahami.
- Setelah berhasil update/create/delete, konfirmasi ke user apa yang sudah dilakukan beserta detail datanya.

FORMAT JAWABAN (SLACK MRKDWN — WAJIB DIIKUTI):
Kamu membalas di Slack, BUKAN di web. Slack TIDAK mendukung Markdown standar. Gunakan format Slack mrkdwn:
- Bold: *teks bold* (satu bintang, BUKAN dua bintang)
- Italic: _teks italic_ (underscore)
- Strikethrough: ~teks coret~
- Code inline: \`kode\`
- Code block: \`\`\`kode\`\`\`
- Link: <https://url.com|teks link>
- Bullet list: gunakan • atau - di awal baris
- JANGAN PERNAH gunakan tabel Markdown (| --- | ---). Slack tidak bisa render tabel.
- Untuk menampilkan data sebelum/sesudah, gunakan format list:
  • _Sebelum:_ nilai lama
  • _Sesudah:_ *nilai baru*
- JANGAN gunakan heading dengan # (Slack tidak support). Gunakan *bold* untuk judul.
- Emoji diperbolehkan dan disarankan untuk membuat respons lebih friendly.`;

// ---------------------------------------------------------------------------
// Gemini Tool Definitions (different format from Groq/OpenAI)
// ---------------------------------------------------------------------------

/**
 * Gemini uses uppercase type names (STRING, NUMBER, OBJECT, ARRAY)
 * and wraps tools in { functionDeclarations: [...] }
 */
const geminiTools = [
  {
    functionDeclarations: [
      {
        name: 'access_strapi_cms',
        description:
          'Access the Strapi CMS to manage content. Supports listing available collections, ' +
          'retrieving entries from a collection, getting a single entry by ID, creating, ' +
          'updating, deleting entries, and reading/extracting text from PDF attachments. ' +
          'IMPORTANT: If you do not know the numeric entry ID, use "get_entries" with filters first.',
        parameters: {
          type: 'OBJECT',
          properties: {
            action: {
              type: 'STRING',
              description:
                'The action to perform. ' +
                '"list_collections" — list all available content types. Use "search" parameter to filter by name. ' +
                '"get_entries" — list all entries in a collection. Use filters to search by field values. ' +
                '"get_entry" — get a single entry by its numeric ID. ' +
                '"create_entry" — create a new entry (requires "collection" and "data"). ' +
                '"update_entry" — update an existing entry (requires "collection", "entry_id", and "data"). ' +
                '"delete_entry" — delete an entry (requires "collection" and "entry_id"). ' +
                '"read_attachment" — extract text from a PDF attachment in an entry.',
              enum: [
                'list_collections',
                'get_entries',
                'get_entry',
                'create_entry',
                'update_entry',
                'delete_entry',
                'read_attachment',
              ],
            },
            collection: {
              type: 'STRING',
              description:
                'The REST API route name (pluralName) of the Strapi collection, e.g. "articles", "products". ' +
                'Use list_collections to discover the correct route name.',
            },
            entry_id: {
              type: 'STRING',
              description:
                'The numeric ID of a specific entry as a string, e.g. "5", "12". ' +
                'Must be an actual numeric ID — do NOT pass placeholder text.',
            },
            filters: {
              type: 'OBJECT',
              description:
                'Optional Strapi-style filter parameters for get_entries action. ' +
                'Example: {"title": {"$contains": "hello"}}.',
            },
            data: {
              type: 'OBJECT',
              description:
                'The data payload for create_entry and update_entry actions. ' +
                'Must contain the field values to set.',
            },
            search: {
              type: 'STRING',
              description:
                'Optional search keyword for list_collections action. ' +
                'Filters collections whose route or display name contains this keyword (case-insensitive). ' +
                'Example: "venue" will match collections like "venues", "venue-categories", etc.',
            },
          },
          required: ['action'],
        },
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Initialize Slack Bolt App (Socket Mode)
// ---------------------------------------------------------------------------

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
});

// ---------------------------------------------------------------------------
// Initialize Gemini Client
// ---------------------------------------------------------------------------

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({
  model: GEMINI_MODEL,
  tools: geminiTools,
  systemInstruction: SYSTEM_PROMPT,
});

// ---------------------------------------------------------------------------
// Event Handler: app_mention
// ---------------------------------------------------------------------------

app.event('app_mention', async ({ event, client, say }) => {
  const channelId = event.channel;
  const threadTs = event.thread_ts || event.ts;
  const rawText = event.text || '';

  // Strip the bot mention tag (e.g., <@U12345>) from the message
  const userPrompt = rawText.replace(/<@[A-Z0-9]+>/gi, '').trim();

  // If the message is empty after stripping, send a help message
  if (!userPrompt) {
    await say({
      text: '👋 Halo! Saya bisa membantu mengelola data Strapi CMS. Coba tanyakan sesuatu seperti:\n' +
        '• _"Tampilkan semua collection yang tersedia"_\n' +
        '• _"Ambil semua data dari articles"_\n' +
        '• _"Ringkaskan PDF di artikel ID 5"_',
      thread_ts: threadTs,
    });
    return;
  }

  try {
    // Acknowledge with a reaction (non-critical)
    try {
      await client.reactions.add({
        channel: channelId,
        timestamp: event.ts,
        name: 'eyes',
      });
    } catch (_) { /* reactions:write scope not available, skip */ }

    // Run the Gemini tool-calling loop
    const response = await runGeminiToolLoop(userPrompt);

    // Send the final response back to Slack
    await say({
      text: response,
      thread_ts: threadTs,
    });

    // Add a checkmark reaction (non-critical)
    try {
      await client.reactions.add({
        channel: channelId,
        timestamp: event.ts,
        name: 'white_check_mark',
      });
    } catch (_) { /* reactions:write scope not available, skip */ }
  } catch (error) {
    console.error('Error handling app_mention:', error);

    await say({
      text: `⚠️ Maaf, terjadi kesalahan saat memproses permintaan Anda:\n\`\`\`${error.message}\`\`\``,
      thread_ts: threadTs,
    });
  }
});

// ---------------------------------------------------------------------------
// Gemini Tool-Calling Loop
// ---------------------------------------------------------------------------

/**
 * Sends a message via Gemini chat with automatic retry on 429 rate limit errors.
 * Parses the retry delay from the error message and waits accordingly.
 *
 * @param {object} chat    - The Gemini chat session
 * @param {any}    message - The message to send
 * @param {number} retries - Max retries (default 2)
 * @returns {Promise<object>} - The Gemini result
 */
async function sendWithRetry(chat, message, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await chat.sendMessage(message);
    } catch (error) {
      const is429 = error.message?.includes('429') || error.message?.includes('quota');

      if (is429 && attempt < retries) {
        // Parse retry delay from error message (e.g. "Please retry in 48.79s")
        const delayMatch = error.message.match(/retry in (\d+\.?\d*)s/i);
        const waitSec = delayMatch ? Math.ceil(parseFloat(delayMatch[1])) : 30;
        const cappedWait = Math.min(waitSec, 60); // Cap at 60s

        console.log(`[Rate Limit] 429 hit, waiting ${cappedWait}s before retry (attempt ${attempt + 1}/${retries})...`);
        await new Promise((resolve) => setTimeout(resolve, cappedWait * 1000));
        continue;
      }

      throw error; // Re-throw if not 429 or out of retries
    }
  }
}

/**
 * Orchestrates the multi-turn conversation with Gemini, handling tool calls
 * iteratively until the model produces a final text response.
 *
 * @param {string} userPrompt - The cleaned user message
 * @returns {Promise<string>} - The final natural-language response
 */
async function runGeminiToolLoop(userPrompt) {
  const chat = model.startChat();

  let totalToolCalls = 0;
  const seenCalls = new Set();

  // Send the initial user message (with auto-retry on 429)
  let result;
  try {
    result = await sendWithRetry(chat, userPrompt);
  } catch (error) {
    console.error('[Gemini API Error]', error.message);
    return `⚠️ AI gagal memproses permintaan: ${error.message}`;
  }

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
    let functionCalls;
    try {
      functionCalls = result.response.functionCalls();
    } catch (responseError) {
      // Gemini may throw on loop detection or blocked content
      console.error('[Gemini Response Error]', responseError.message);
      // Try to extract text instead
      try {
        const fallbackText = result.response.text();
        if (fallbackText) return fallbackText;
      } catch (_) { /* no text either */ }
      return `⚠️ AI gagal memproses: ${responseError.message}`;
    }

    // If no function calls, return the text response
    if (!functionCalls || functionCalls.length === 0) {
      try {
        return result.response.text() || '(Tidak ada respons dari AI)';
      } catch (textError) {
        console.error('[Gemini Text Error]', textError.message);
        return `⚠️ AI gagal menghasilkan respons: ${textError.message}`;
      }
    }

    // Process each function call and build response parts
    const functionResponses = [];

    for (const call of functionCalls) {
      totalToolCalls++;

      // Hard limit on total tool calls
      if (totalToolCalls > MAX_TOTAL_TOOL_CALLS) {
        console.log(`[Loop Guard] Exceeded ${MAX_TOTAL_TOOL_CALLS} total tool calls, stopping.`);
        return '⚠️ Terlalu banyak pemanggilan tool. Silakan coba pertanyaan yang lebih spesifik.';
      }

      const callSignature = JSON.stringify({ fn: call.name, args: call.args });

      // Detect repeated identical calls
      if (seenCalls.has(callSignature)) {
        console.log(`[Loop Guard] Duplicate call detected: ${callSignature.substring(0, 100)}`);
        functionResponses.push({
          functionResponse: {
            name: call.name,
            response: {
              error: 'This exact call was already made. Do NOT repeat it. ' +
                'Try a different approach or respond with what you know.',
            },
          },
        });
        continue;
      }
      seenCalls.add(callSignature);

      console.log(
        `[Tool Call #${totalToolCalls}] ${call.name}(${JSON.stringify(call.args)})`
      );

      const toolResult = await executeToolCall(call.name, call.args || {});
      let parsedResult;
      try {
        parsedResult = JSON.parse(toolResult);
      } catch (_) {
        parsedResult = { result: toolResult };
      }

      console.log(
        `[Tool Result] ${toolResult.substring(0, 200)}${toolResult.length > 200 ? '...' : ''}`
      );

      functionResponses.push({
        functionResponse: {
          name: call.name,
          response: parsedResult,
        },
      });
    }

    // Send all function responses back to Gemini (with auto-retry on 429)
    try {
      result = await sendWithRetry(chat, functionResponses);
    } catch (error) {
      console.error('[Gemini API Error]', error.message);
      return `⚠️ AI gagal memproses hasil tool: ${error.message}`;
    }
  }

  // Final check — model might have responded with text after the last iteration
  try {
    const finalText = result.response.text();
    if (finalText) return finalText;
  } catch (_) { /* no text response */ }

  return '⚠️ Proses terlalu kompleks — mencapai batas maksimum iterasi tool. Silakan coba pertanyaan yang lebih spesifik.';
}

// ---------------------------------------------------------------------------
// Start the App
// ---------------------------------------------------------------------------

(async () => {
  try {
    await app.start();
    console.log('⚡️ Slack AI Agent is running! (Gemini)');
    console.log(`   Model  : ${GEMINI_MODEL}`);
    console.log(`   Strapi : ${process.env.STRAPI_URL || 'http://localhost:1337'}`);
  } catch (error) {
    console.error('❌ Failed to start the app:', error.message);
    process.exit(1);
  }
})();
