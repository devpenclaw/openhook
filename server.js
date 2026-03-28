const express = require("express");
const path = require("path");
const crypto = require("crypto");

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

// In-memory store for webhooks
const webhooks = new Map();
const endpoints = new Map();

// Generate unique endpoint
function generateEndpoint() {
  return "hook_" + crypto.randomBytes(6).toString("hex");
}

// Create default endpoint
const demoEndpoint = generateEndpoint();
endpoints.set(demoEndpoint, { created: Date.now() });
webhooks.set(demoEndpoint, []);

// Receive webhook
app.post("/api/hook/:endpoint", (req, res) => {
  const endpoint = req.params.endpoint;
  
  if (!webhooks.has(endpoint)) {
    webhooks.set(endpoint, []);
    endpoints.set(endpoint, { created: Date.now() });
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
  
  res.json({ success: true, id: webhook.id });
});

// Get webhooks for endpoint
app.get("/api/hooks/:endpoint", (req, res) => {
  const endpoint = req.params.endpoint;
  res.json(webhooks.get(endpoint) || []);
});

// Create new endpoint
app.post("/api/endpoints", (req, res) => {
  const endpoint = generateEndpoint();
  endpoints.set(endpoint, { created: Date.now() });
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