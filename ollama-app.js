/**
 * ollama-app.js
 *
 * Entry point for the Slack AI Agent (Ollama variant). Sets up the Slack Bolt
 * app in Socket Mode, listens for @mentions, and orchestrates the Ollama LLM
 * tool-calling loop (using llama3.1) to interact with Strapi CMS.
 */

require('dotenv').config();

const { App } = require('@slack/bolt');
const ollama = require('ollama').default;
const { toolDefinitions, executeToolCall } = require('./strapiTools');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const OLLAMA_MODEL = 'llama3.1';
const MAX_TOOL_ITERATIONS = 3; // Safety limit to prevent infinite tool-call loops

const SYSTEM_PROMPT = `Kamu adalah asisten AI yang membantu mengelola data pada Strapi CMS.
Kamu terhubung ke instance Strapi v4 melalui tool "access_strapi_cms".

Kemampuanmu:
1. Melihat daftar semua Collection Types dan Single Types yang tersedia.
2. Mengambil data (entries) dari collection manapun.
3. Mengambil detail entry tertentu berdasarkan ID.
4. Membuat, mengubah, dan menghapus entry.
5. Membaca dan meringkas isi file PDF yang terlampir pada entry Strapi.

ATURAN PENTING:
- Gunakan action "list_collections" PERTAMA untuk mendapatkan nama route yang benar. Gunakan nilai "route" dari hasilnya sebagai parameter "collection".
- Jangan pernah menebak nama collection. Selalu gunakan list_collections dulu.
- Jika user meminta data tapi tidak menyebutkan ID, gunakan "get_entries" dengan filters untuk mencari entry yang relevan.
- Parameter "entry_id" HARUS berupa angka nyata (contoh: "5", "12"). JANGAN PERNAH memasukkan placeholder atau teks seperti "entry_id_from_get_entries" — ini akan error.
- Untuk update/delete, SELALU cari entry dulu dengan get_entries untuk mendapatkan ID numerik yang benar.
- Jika user meminta ringkasan PDF, gunakan action "read_attachment" lalu ringkas hasilnya.
- Selalu jawab dalam bahasa yang sama dengan bahasa user (Indonesia atau English).
- Berikan jawaban yang ringkas dan informatif.
- Jika terjadi error, jelaskan masalahnya dengan bahasa yang mudah dipahami.`;

// ---------------------------------------------------------------------------
// Initialize Slack Bolt App (Socket Mode)
// ---------------------------------------------------------------------------

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
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

    // Run the Ollama tool-calling loop
    const response = await runOllamaToolLoop(userPrompt);

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
// Ollama Tool-Calling Loop
// ---------------------------------------------------------------------------

/**
 * Orchestrates the multi-turn conversation with Ollama, handling tool calls
 * iteratively until the LLM produces a final text response.
 *
 * Flow:
 * 1. Send user prompt + tool definitions to Ollama
 * 2. If Ollama responds with tool_calls, execute each tool
 * 3. Feed tool results back to Ollama
 * 4. Repeat until Ollama produces a text response (no more tool_calls)
 *
 * @param {string} userPrompt - The cleaned user message
 * @returns {Promise<string>} - The final natural-language response
 */
async function runOllamaToolLoop(userPrompt) {
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userPrompt },
  ];

  let totalToolCalls = 0;
  const MAX_TOTAL_TOOL_CALLS = 6;
  const seenCalls = new Set();

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
    let response;
    try {
      response = await ollama.chat({
        model: OLLAMA_MODEL,
        messages,
        tools: toolDefinitions,
      });
    } catch (ollamaError) {
      // Handle Ollama errors (e.g. model not found, connection refused) gracefully
      console.error('[Ollama API Error]', ollamaError.message);
      return `⚠️ AI gagal memproses permintaan: ${ollamaError.message}`;
    }

    const assistantMessage = response.message;

    // If no tool calls, return the text response
    if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
      return assistantMessage.content || '(Tidak ada respons dari AI)';
    }

    // Append the assistant's message (with tool_calls) to conversation history
    messages.push(assistantMessage);

    // Execute each tool call and add results to conversation
    for (const toolCall of assistantMessage.tool_calls) {
      totalToolCalls++;

      // Hard limit on total tool calls
      if (totalToolCalls > MAX_TOTAL_TOOL_CALLS) {
        console.log(`[Loop Guard] Exceeded ${MAX_TOTAL_TOOL_CALLS} total tool calls, stopping.`);
        return '⚠️ Terlalu banyak pemanggilan tool. Silakan coba pertanyaan yang lebih spesifik.';
      }

      const functionName = toolCall.function.name;
      const functionArgs = toolCall.function.arguments;
      const callSignature = JSON.stringify({ fn: functionName, args: functionArgs });

      // Detect repeated identical calls
      if (seenCalls.has(callSignature)) {
        console.log(`[Loop Guard] Duplicate call detected: ${callSignature.substring(0, 100)}`);
        messages.push({
          role: 'tool',
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
        content: result,
      });
    }
  }

  return '⚠️ Proses terlalu kompleks — mencapai batas maksimum iterasi tool. Silakan coba pertanyaan yang lebih spesifik.';
}

// ---------------------------------------------------------------------------
// Start the App
// ---------------------------------------------------------------------------

(async () => {
  try {
    await app.start();
    console.log('⚡️ Slack AI Agent is running! (Ollama)');
    console.log(`   Model  : ${OLLAMA_MODEL}`);
    console.log(`   Ollama : ${process.env.OLLAMA_HOST || 'http://localhost:11434'}`);
    console.log(`   Strapi : ${process.env.STRAPI_URL || 'http://localhost:1337'}`);
  } catch (error) {
    console.error('❌ Failed to start the app:', error.message);
    process.exit(1);
  }
})();
