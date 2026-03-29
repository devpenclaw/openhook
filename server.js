const express = require("express");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

// pg pool (like careflow)
const pool = new Pool({ 
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// In-memory fallback
const endpoints = new Map();
const webhooks = new Map();

// Generate unique endpoint
function generateEndpoint() {
  return "hook_" + crypto.randomBytes(6).toString("hex");
}

// Create demo endpoint
const demoEndpoint = generateEndpoint();
endpoints.set(demoEndpoint, { created: Date.now() });
webhooks.set(demoEndpoint, []);

// Init DB tables
async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS endpoints (
        id SERIAL PRIMARY KEY,
        endpoint VARCHAR(64) UNIQUE NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS webhooks (
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
      )
    `);
    console.log("Database tables ready");
  } catch (e) {
    console.log("DB init note:", e.message);
  }
}

// Receive webhook
app.post("/api/hook/:endpoint", async (req, res) => {
  try {
    const endpoint = req.params.endpoint;
    
    // Try to save to DB
    try {
      let result = await pool.query("SELECT id FROM endpoints WHERE endpoint = $1", [endpoint]);
      let endpointId;
      
      if (result.rows.length === 0) {
        const newResult = await pool.query("INSERT INTO endpoints (endpoint) VALUES ($1) RETURNING id", [endpoint]);
        endpointId = newResult.rows[0].id;
      } else {
        endpointId = result.rows[0].id;
      }
      
      const webhookId = crypto.randomBytes(4).toString("hex");
      await pool.query(
        "INSERT INTO webhooks (endpoint_id, webhook_id, method, path, headers, body, query, time) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
        [endpointId, webhookId, req.method, "/api/hook/" + endpoint, JSON.stringify(req.headers), JSON.stringify(req.body), JSON.stringify(req.query), Date.now()]
      );
      
      return res.json({ success: true, id: webhookId, mode: "db" });
    } catch (dbError) {
      console.log("DB fallback:", dbError.message);
    }
    
    // In-memory fallback
    if (!endpoints.has(endpoint)) {
      endpoints.set(endpoint, { created: Date.now() });
      webhooks.set(endpoint, []);
    }
    
    const webhook = {
      id: crypto.randomBytes(4).toString("hex"),
      method: req.method,
      path: "/api/hook/" + endpoint,
      headers: req.headers,
      body: req.body,
      query: req.query,
      time: Date.now()
    };
    
    webhooks.get(endpoint).unshift(webhook);
    if (webhooks.get(endpoint).length > 100) {
      webhooks.get(endpoint).pop();
    }
    
    res.json({ success: true, id: webhook.id, mode: "memory" });
  } catch (e) {
    console.error("Webhook error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// Get webhooks for endpoint
app.get("/api/hooks/:endpoint", async (req, res) => {
  try {
    const endpoint = req.params.endpoint;
    try {
      const result = await pool.query(
        "SELECT w.webhook_id as id, w.method, w.path, w.headers, w.body, w.query, w.time FROM webhooks w JOIN endpoints e ON w.endpoint_id = e.id WHERE e.endpoint = $1 ORDER BY w.time DESC LIMIT 50",
        [endpoint]
      );
      if (result.rows.length > 0) {
        return res.json(result.rows);
      }
    } catch (dbError) {
      // Fallback
    }
    
    res.json(webhooks.get(endpoint) || []);
  } catch (e) {
    console.error("Get webhooks error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// Create new endpoint
app.post("/api/endpoints", (req, res) => {
  const endpoint = generateEndpoint();
  endpoints.set(endpoint, { created: Date.now() });
  webhooks.set(endpoint, []);
  res.json({ endpoint });
});

// Get all endpoints
app.get("/api/endpoints", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT e.endpoint, e.created_at, COUNT(w.id) as count FROM endpoints e LEFT JOIN webhooks w ON w.endpoint_id = e.id GROUP BY e.id, e.endpoint, e.created_at ORDER BY e.created_at DESC LIMIT 10"
    );
    if (result.rows.length > 0) {
      return res.json(result.rows);
    }
  } catch (e) {
    // Fallback
  }
  
  const list = [];
  endpoints.forEach((data, endpoint) => {
    list.push({
      endpoint,
      created: data.created,
      count: (webhooks.get(endpoint) || []).length
    });
  });
  res.json(list.sort((a, b) => b.created - a.created).slice(0, 10));
});

// Health check
app.get("/api/health", (req, res) => {
  res.json({ status: "ok" });
});

// Serve static files
app.use(express.static(__dirname));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// Init DB
initDB();

module.exports = app;