/**
 * deepseek-app.js
 *
 * Entry point for the Slack AI Agent using DeepSeek LLM.
 * Sets up the Slack Bolt app in Socket Mode, listens for @mentions,
 * and orchestrates the DeepSeek tool-calling loop to interact with Strapi CMS.
 *
 * DeepSeek API is OpenAI-compatible, so we use the OpenAI SDK
 * pointed at DeepSeek's base URL.
 */

require('dotenv').config();

const { App } = require('@slack/bolt');
const OpenAI = require('openai');
const { toolDefinitions, executeToolCall } = require('./strapiTools');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DEEPSEEK_MODEL = 'deepseek-chat'; // DeepSeek-V3; use 'deepseek-reasoner' for R1
const MAX_TOOL_ITERATIONS = 10; // Safety limit to prevent infinite tool-call loops

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
// Initialize Slack Bolt App (Socket Mode)
// ---------------------------------------------------------------------------

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
});

// ---------------------------------------------------------------------------
// Initialize DeepSeek Client (OpenAI-compatible)
// ---------------------------------------------------------------------------

const deepseek = new OpenAI({
  baseURL: 'https://api.deepseek.com',
  apiKey: process.env.DEEPSEEK_API_KEY,
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
    // Acknowledge with a reaction (non-critical — may fail if reactions:write scope is missing)
    try {
      await client.reactions.add({
        channel: channelId,
        timestamp: event.ts,
        name: 'eyes',
      });
    } catch (_) { /* reactions:write scope not available, skip */ }

    // Run the DeepSeek tool-calling loop
    const response = await runDeepSeekToolLoop(userPrompt);

    // Send the final response back to Slack
    await say({
      text: response,
      thread_ts: threadTs,
    });

    // Add a checkmark reaction to indicate completion (non-critical)
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
// DeepSeek Tool-Calling Loop
// ---------------------------------------------------------------------------

/**
 * Orchestrates the multi-turn conversation with DeepSeek, handling tool calls
 * iteratively until the LLM produces a final text response.
 *
 * Flow:
 * 1. Send user prompt + tool definitions to DeepSeek
 * 2. If DeepSeek responds with tool_calls, execute each tool
 * 3. Feed tool results back to DeepSeek
 * 4. Repeat until DeepSeek produces a text response (no more tool_calls)
 *
 * @param {string} userPrompt - The cleaned user message
 * @returns {Promise<string>} - The final natural-language response
 */
async function runDeepSeekToolLoop(userPrompt) {
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userPrompt },
  ];

  let totalToolCalls = 0;
  const MAX_TOTAL_TOOL_CALLS = 15;
  const seenCalls = new Set();

  // Token usage tracking
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let totalTokensUsed = 0;

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
    let response;
    try {
      response = await deepseek.chat.completions.create({
        model: DEEPSEEK_MODEL,
        messages,
        tools: toolDefinitions,
        tool_choice: 'auto',
        temperature: 0.3,
        max_tokens: 4096,
      });
    } catch (apiError) {
      // Handle DeepSeek API errors gracefully
      console.error('[DeepSeek API Error]', apiError.message);
      return `⚠️ AI gagal memproses permintaan: ${apiError.error?.error?.message || apiError.message}`;
    }

    // Accumulate token usage from this API call
    if (response.usage) {
      totalPromptTokens += response.usage.prompt_tokens || 0;
      totalCompletionTokens += response.usage.completion_tokens || 0;
      totalTokensUsed += response.usage.total_tokens || 0;
      console.log(
        `[Token Usage] Iteration ${iteration + 1}: ` +
        `prompt=${response.usage.prompt_tokens}, ` +
        `completion=${response.usage.completion_tokens}, ` +
        `total=${response.usage.total_tokens}`
      );
    }

    const assistantMessage = response.choices[0].message;

    // If no tool calls, return the text response with token usage footer
    if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
      const content = assistantMessage.content || '(Tidak ada respons dari AI)';
      const tokenFooter = formatTokenFooter(totalPromptTokens, totalCompletionTokens, totalTokensUsed);
      return `${content}\n\n${tokenFooter}`;
    }

    // Append the assistant's message (with tool_calls) to conversation history
    messages.push(assistantMessage);

    // Execute each tool call and add results to conversation
    for (const toolCall of assistantMessage.tool_calls) {
      totalToolCalls++;

      // Hard limit on total tool calls
      if (totalToolCalls > MAX_TOTAL_TOOL_CALLS) {
        console.log(`[Loop Guard] Exceeded ${MAX_TOTAL_TOOL_CALLS} total tool calls, stopping.`);
        const tokenFooter = formatTokenFooter(totalPromptTokens, totalCompletionTokens, totalTokensUsed);
        return `⚠️ Terlalu banyak pemanggilan tool. Silakan coba pertanyaan yang lebih spesifik.\n\n${tokenFooter}`;
      }

      const functionName = toolCall.function.name;
      const functionArgs = JSON.parse(toolCall.function.arguments);
      const callSignature = JSON.stringify({ fn: functionName, args: functionArgs });

      // Detect repeated identical calls
      if (seenCalls.has(callSignature)) {
        console.log(`[Loop Guard] Duplicate call detected: ${callSignature.substring(0, 100)}`);
        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: JSON.stringify({
            error: 'This exact call was already made and returned the same result. ' +
              'Do NOT repeat it. Try a different approach or respond to the user with what you know.',
          }),
        });
        continue;
      }
      seenCalls.add(callSignature);

      console.log(
        `[Tool Call #${totalToolCalls}] ${functionName}(${JSON.stringify(functionArgs)})`
      );

      const result = await executeToolCall(functionName, functionArgs);

      console.log(
        `[Tool Result] ${result.substring(0, 200)}${result.length > 200 ? '...' : ''}`
      );

      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: result,
      });
    }
  }

  const tokenFooter = formatTokenFooter(totalPromptTokens, totalCompletionTokens, totalTokensUsed);
  return `⚠️ Proses terlalu kompleks — mencapai batas maksimum iterasi tool. Silakan coba pertanyaan yang lebih spesifik.\n\n${tokenFooter}`;
}

/**
 * Formats a human-readable token usage footer for Slack messages.
 *
 * @param {number} promptTokens - Total prompt (input) tokens
 * @param {number} completionTokens - Total completion (output) tokens
 * @param {number} totalTokens - Total tokens used
 * @returns {string} Formatted token usage string
 */
function formatTokenFooter(promptTokens, completionTokens, totalTokens) {
  // DeepSeek-V3 pricing (as of 2025): $0.27/M input, $1.10/M output (cache miss)
  const inputCost = (promptTokens / 1_000_000) * 0.27;
  const outputCost = (completionTokens / 1_000_000) * 1.10;
  const estimatedCost = inputCost + outputCost;

  return `───────────────\n` +
    `📊 *Token Usage*\n` +
    `• Input: ${promptTokens.toLocaleString()} tokens\n` +
    `• Output: ${completionTokens.toLocaleString()} tokens\n` +
    `• Total: ${totalTokens.toLocaleString()} tokens\n` +
    `• Est. Cost: ~$${estimatedCost.toFixed(6)}`;
}

// ---------------------------------------------------------------------------
// Start the App
// ---------------------------------------------------------------------------

(async () => {
  try {
    await app.start();
    console.log('⚡️ Slack AI Agent is running! (DeepSeek)');
    console.log(`   Model  : ${DEEPSEEK_MODEL}`);
    console.log(`   Strapi : ${process.env.STRAPI_URL || 'http://localhost:1337'}`);
  } catch (error) {
    console.error('❌ Failed to start the app:', error.message);
    process.exit(1);
  }
})();
