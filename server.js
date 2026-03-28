const express = require("express");
const path = require("path");
const crypto = require("crypto");
const fs = require("fs");

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

// In-memory store for webhooks (would be database in production)
const webhooks = new Map();
const endpoints = new Map();

// Generate unique endpoint
function generateEndpoint() {
  return "hook_" + crypto.randomBytes(6).toString("hex");
}

// Create default endpoint for demo
const demoEndpoint = generateEndpoint();
endpoints.set(demoEndpoint, {
  created: Date.now(),
  webhooks: []
});
webhooks.set(demoEndpoint, []);

// Receive webhook
app.post("/api/hook/:endpoint", (req, res) => {
  const { endpoint } = req.params;
  
  // Create endpoint if doesn't exist
  if (!endpoints.has(endpoint)) {
    endpoints.set(endpoint, { created: Date.now(), webhooks: [] });
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
  
  // Keep only last 100 webhooks per endpoint
  if (webhooks.get(endpoint).length > 100) {
    webhooks.get(endpoint).pop();
  }
  
  res.json({ success: true, id: webhook.id });
});

// Get webhooks for endpoint
app.get("/api/hooks/:endpoint", (req, res) => {
  const { endpoint } = req.params;
  const hooks = webhooks.get(endpoint) || [];
  res.json(hooks);
});

// Get single webhook
app.get("/api/hook/:endpoint/:id", (req, res) => {
  const { endpoint, id } = req.params;
  const hooks = webhooks.get(endpoint) || [];
  const hook = hooks.find(h => h.id === id);
  if (!hook) return res.status(404).json({ error: "Not found" });
  res.json(hook);
});

// Replay webhook
app.post("/api/replay/:endpoint/:id", async (req, res) => {
  const { endpoint, id } = req.params;
  const hooks = webhooks.get(endpoint) || [];
  const hook = hooks.find(h => h.id === id);
  if (!hook) return res.status(404).json({ error: "Not found" });
  
  // Forward to target URL if provided
  const targetUrl = req.body.url;
  if (targetUrl) {
    try {
      const forwardRes = await fetch(targetUrl, {
        method: hook.method,
        headers: hook.headers,
        body: JSON.stringify(hook.body)
      });
      return res.json({ success: true, status: forwardRes.status });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }
  
  res.json({ success: true, message: "Would replay to original target" });
});

// Create new endpoint
app.post("/api/endpoints", (req, res) => {
  const endpoint = generateEndpoint();
  endpoints.set(endpoint, { created: Date.now(), webhooks: [] });
  webhooks.set(endpoint, []);
  res.json({ endpoint });
});

// Get all endpoints
app.get("/api/endpoints", (req, res) => {
  const list = [];
  endpoints.forEach((data, endpoint) => {
    list.push({
      endpoint,
      created: data.created,
      count: (webhooks.get(endpoint) || []).length
    });
  });
  res.json(list);
});

// Serve static files
app.use(express.static(__dirname));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

module.exports = app;