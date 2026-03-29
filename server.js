const express = require("express");
const path = require("path");
const crypto = require("crypto");
const { postgres } = require("postgres");

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

// Neon connection
const sql = postgres("postgres://neondb_owner:npg_ibD3tZpL8nNo@ep-long-union-abxnub5o-pooler.eu-west-2.aws.neon.tech/neondb", {
  ssl: { rejectUnauthorized: false },
  max: 1
});

// Initialize database
async function initDB() {
  try {
    await sql`CREATE TABLE IF NOT EXISTS endpoints (
      id SERIAL PRIMARY KEY,
      endpoint VARCHAR(64) UNIQUE NOT NULL,
      created TIMESTAMP DEFAULT NOW()
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
      created TIMESTAMP DEFAULT NOW()
    )`;
    
    await sql`CREATE INDEX IF NOT EXISTS idx_webhooks_endpoint ON webhooks(endpoint_id)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_webhooks_time ON webhooks(time DESC)`;
    
    console.log("Database initialized");
  } catch (e) {
    console.error("DB init error:", e.message);
  }
}

// Generate unique endpoint
function generateEndpoint() {
  return "hook_" + crypto.randomBytes(6).toString("hex");
}

// Receive webhook
app.post("/api/hook/:endpoint", async (req, res) => {
  try {
    const endpoint = req.params.endpoint;
    
    // Find or create endpoint
    let endpoints = await sql`SELECT id FROM endpoints WHERE endpoint = ${endpoint}`;
    let endpointId;
    
    if (endpoints.length === 0) {
      const result = await sql`INSERT INTO endpoints (endpoint) VALUES (${endpoint}) RETURNING id`;
      endpointId = result[0].id;
    } else {
      endpointId = endpoints[0].id;
    }
    
    // Insert webhook
    const webhookId = crypto.randomBytes(4).toString("hex");
    await sql`INSERT INTO webhooks (endpoint_id, webhook_id, method, path, headers, body, query, time)
      VALUES (${endpointId}, ${webhookId}, ${req.method}, ${"/api/hook/" + endpoint}, ${JSON.stringify(req.headers)}, ${JSON.stringify(req.body)}, ${JSON.stringify(req.query)}, ${Date.now()})`;
    
    // Keep only last 100 per endpoint
    await sql`DELETE FROM webhooks WHERE endpoint_id = ${endpointId} AND id NOT IN (
      SELECT id FROM webhooks WHERE endpoint_id = ${endpointId} ORDER BY time DESC LIMIT 100
    )`;
    
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
    const endpoints = await sql`SELECT id FROM endpoints WHERE endpoint = ${endpoint}`;
    
    if (endpoints.length === 0) {
      return res.json([]);
    }
    
    const webhooks = await sql`
      SELECT webhook_id as id, method, path, headers, body, query, time 
      FROM webhooks 
      WHERE endpoint_id = ${endpoints[0].id}
      ORDER BY time DESC 
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
      SELECT e.endpoint, e.created, COUNT(w.id)::int as count
      FROM endpoints e
      LEFT JOIN webhooks w ON w.endpoint_id = e.id
      GROUP BY e.id, e.endpoint, e.created
      ORDER BY e.created DESC
      LIMIT 10
    `;
    res.json(endpoints);
  } catch (e) {
    console.error("Get endpoints error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// Serve static files
app.use(express.static(__dirname));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// Initialize and start
initDB();

module.exports = app;