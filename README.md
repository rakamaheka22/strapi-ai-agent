# Slack AI Agent — Strapi v4 + Groq LLM

> AI Agent yang menghubungkan **Slack** dengan **Strapi v4 CMS** menggunakan **Groq LLM (Llama 3)** untuk pemrosesan bahasa alami dan tool calling.

## 🏗 Architecture

```
Slack User  ──▶  Slack (Socket Mode)  ──▶  Node.js Middleware  ──▶  Groq LLM
                                                │                      │
                                                │  ◀── tool_calls ─────┘
                                                │
                                                ▼
                                          Strapi v4 API
                                          (CRUD + PDF)
```

1. **Input:** User me-mention bot di Slack dengan perintah bahasa natural
2. **Detection:** Slack Bolt mengirim event `app_mention` ke middleware
3. **Reasoning:** Groq LLM memproses prompt dan memutuskan tool call yang diperlukan
4. **Execution:** Middleware mengeksekusi request ke Strapi API
5. **Synthesis:** Hasil dikirim kembali ke Groq untuk dirangkum
6. **Output:** Jawaban natural dikirim ke Slack

## 📋 Prerequisites

- **Node.js** v18 atau lebih baru
- **Strapi v4** instance yang running (self-hosted)
- **Slack App** dengan Socket Mode aktif
- **Groq API Key** dari [console.groq.com](https://console.groq.com)

## 🚀 Quick Start

### 1. Clone & Install

```bash
cd strapi-ai-agent
npm install
```

### 2. Setup Slack App

1. Buka [api.slack.com/apps](https://api.slack.com/apps) dan buat app baru
2. **Socket Mode:** Aktifkan di menu "Socket Mode", buat App-Level Token dengan scope `connections:write`
3. **Event Subscriptions:** Subscribe ke event `app_mention`
4. **Bot Token Scopes** (OAuth & Permissions):
   - `app_mentions:read`
   - `chat:write`
   - `reactions:write`
5. Install app ke workspace, copy **Bot Token** (`xoxb-...`)

### 3. Setup Strapi API Token

1. Buka Strapi Admin Panel → **Settings** → **API Tokens**
2. Buat token baru dengan tipe **Full Access**
3. Copy token tersebut

### 4. Configure Environment

Edit file `.env` dengan kredensial yang sudah didapat:

```env
SLACK_BOT_TOKEN=xoxb-your-bot-token
SLACK_APP_TOKEN=xapp-your-app-token
GROQ_API_KEY=gsk_your-groq-key
STRAPI_URL=http://localhost:1337
STRAPI_API_TOKEN=your-strapi-api-token
```

### 5. Run

```bash
# Production
npm start

# Development (auto-reload)
npm run dev
```

## 💬 Usage Examples

Mention bot di channel Slack:

| Prompt                                          | Aksi                                               |
| ----------------------------------------------- | -------------------------------------------------- |
| `@Bot tampilkan semua collection yang tersedia` | List semua content types di Strapi                 |
| `@Bot ambil semua data dari articles`           | List semua entries dari collection "articles"      |
| `@Bot tampilkan artikel dengan ID 3`            | Get detail entry #3 dari "articles"                |
| `@Bot ringkaskan isi PDF di artikel ID 5`       | Download PDF, extract teks, dan berikan ringkasan  |
| `@Bot apa saja field di collection products?`   | List collections lalu tampilkan field yang relevan |

## 🛠 Project Structure

```
strapi-ai-agent/
├── .env                # Kredensial & API Keys
├── .gitignore          # Git ignore rules
├── app.js              # Entry point — Slack listener + Groq orchestration
├── strapiTools.js      # Tool definitions + Strapi API integration
├── package.json        # Dependencies
└── README.md           # Dokumentasi (file ini)
```

## 🔧 How It Works

### Tool Calling (MCP Concept)

Bot menggunakan satu tool universal `access_strapi_cms` dengan 4 action:

| Action             | Deskripsi                                               |
| ------------------ | ------------------------------------------------------- |
| `list_collections` | Daftar semua Collection Types & Single Types            |
| `get_entries`      | Ambil semua entries dari collection (+ filter opsional) |
| `get_entry`        | Ambil satu entry berdasarkan ID                         |
| `read_attachment`  | Download & extract teks dari PDF attachment             |

### Flow Tool Calling

```
User Prompt → Groq (+ tool defs) → tool_call → Execute → Result → Groq → Final Answer
                                        ↑                            │
                                        └──── loop if more tools ────┘
```

## ⚠️ Troubleshooting

| Masalah                    | Solusi                                                                                     |
| -------------------------- | ------------------------------------------------------------------------------------------ |
| `Cannot connect to Strapi` | Pastikan Strapi running dan URL di `.env` benar                                            |
| `401 Unauthorized`         | Cek API Token Strapi — harus Full Access                                                   |
| `Socket Mode error`        | Pastikan `SLACK_APP_TOKEN` (`xapp-...`) benar dan Socket Mode aktif                        |
| `Model not found`          | Cek model tersedia di [console.groq.com/docs/models](https://console.groq.com/docs/models) |
| `PDF extraction empty`     | File mungkin scan-based (gambar), bukan text-based PDF                                     |

## 📝 License

MIT
