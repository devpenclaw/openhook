const express = require("express");
const path = require("path");
const crypto = require("crypto");
const { neon } = require("@neondatabase/serverless");

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

// Neon connection - using DATABASE_URL env variable set in Vercel
const sql = neon(process.env.DATABASE_URL);

// Create tables if not exist
async function initDB() {
  try {
    await sql`CREATE TABLE IF NOT EXISTS endpoints (
      id SERIAL PRIMARY KEY,
      endpoint VARCHAR(64) UNIQUE NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )`;
    await sql`CREATE TABLE IF NOT EXISTS webhooks (
      id SERIAL PRIMARY KEY,
      endpoint_id INTEGER REFERENCES endpoints(id) ON DELETE CASCADE,
      webhook_id VARCHAR(16) NOT NULL,
      method VARCHAR(10) NOT NULL,
      path TEXT NOT NULL,
      headers JSONB,
      body JSONB,
      query JSONB,
      time BIGINT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )`;
    console.log("Neon tables initialized");
  } catch (e) {
    console.error("DB init error:", e.message);
  }
}

// Generate unique endpoint
function generateEndpoint() {
  return "hook_" + crypto.randomBytes(6).toString("hex");
}

// Create demo endpoint
initDB();

const demoEndpoint = generateEndpoint();

// Receive webhook
app.post("/api/hook/:endpoint", async (req, res) => {
  try {
    const endpoint = req.params.endpoint;
    
    // Find or create endpoint
    let result = await sql`SELECT id FROM endpoints WHERE endpoint = ${endpoint}`;
    let endpointId;
    
    if (result.length === 0) {
      result = await sql`INSERT INTO endpoints (endpoint) VALUES (${endpoint}) RETURNING id`;
      endpointId = result[0].id;
    } else {
      endpointId = result[0].id;
    }
    
    // Insert webhook
    const webhookId = crypto.randomBytes(4).toString("hex");
    await sql`INSERT INTO webhooks (endpoint_id, webhook_id, method, path, headers, body, query, time)
      VALUES (${endpointId}, ${webhookId}, ${req.method}, ${"/api/hook/" + endpoint}, ${JSON.stringify(req.headers)}, ${JSON.stringify(req.body)}, ${JSON.stringify(req.query)}, ${Date.now()})`;
    
    res.json({ success: true, id: webhookId });
  } catch (e) {
    console.error("Webhook error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// Get webhooks for endpoint
app.get("/api/hooks/:endpoint", async (req, res) => {
  try {
    const endpoint = req.params.endpoint;
    const webhooks = await sql`
      SELECT w.webhook_id as id, w.method, w.path, w.headers, w.body, w.query, w.time 
      FROM webhooks w 
      JOIN endpoints e ON w.endpoint_id = e.id 
      WHERE e.endpoint = ${endpoint}
      ORDER BY w.time DESC 
      LIMIT 50
    `;
    res.json(webhooks);
  } catch (e) {
    console.error("Get webhooks error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// Create new endpoint
app.post("/api/endpoints", async (req, res) => {
  try {
    const endpoint = generateEndpoint();
    await sql`INSERT INTO endpoints (endpoint) VALUES (${endpoint})`;
    res.json({ endpoint });
  } catch (e) {
    console.error("Create endpoint error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// Get all endpoints
app.get("/api/endpoints", async (req, res) => {
  try {
    const endpoints = await sql`
      SELECT e.endpoint, e.created_at, COUNT(w.id)::int as count
      FROM endpoints e
      LEFT JOIN webhooks w ON w.endpoint_id = e.id
      GROUP BY e.id, e.endpoint, e.created_at
      ORDER BY e.created_at DESC
      LIMIT 10
    `;
    res.json(endpoints);
  } catch (e) {
    console.error("Get endpoints error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// Health check
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", mode: "neon" });
});

// Serve static files
app.use(express.static(__dirname));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

module.exports = app;