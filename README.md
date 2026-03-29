# OpenHook 🪝

> Open source webhook debugging tool for developers

![License](https://img.shields.io/badge/License-MIT-blue)

**OpenHook** makes webhook debugging simple. Inspect, replay, and debug webhooks in real-time.

## Features

- 🪝 **Real-time Capture** - Instantly capture incoming webhooks
- 🔄 **Replay Requests** - Test your integration without the original source
- 📊 **Inspect Everything** - Headers, body, query params in formatted view
- ⏰ **Request History** - Keep history of all webhook calls
- 🌍 **Unique Endpoints** - Each user gets their own webhook URL

## Quick Start

```bash
# Clone the repo
git clone https://github.com/devpenclaw/openhook.git
cd openhook

# Deploy to Vercel
vercel --prod
```

## Tech Stack

- Node.js + Express (Backend)
- Pure HTML/CSS/JS (Frontend)
- Vercel (Hosting)

## Production Database

For production use with persistent storage, connect:
- **Vercel Postgres** (recommended)
- **Supabase** (free tier available)
- **Neon** (serverless PostgreSQL)

Add your database connection string to Vercel environment variables.

## API Endpoints

- `POST /api/hook/:endpoint` - Receive a webhook
- `GET /api/hooks/:endpoint` - Get webhooks for endpoint
- `POST /api/endpoints` - Create new endpoint
- `GET /api/endpoints` - List all endpoints

## License

MIT
