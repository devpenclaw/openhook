const express = require("express");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const cookieParser = require("cookie-parser");

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// JWT Secret
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString("hex");
const FROM_EMAIL = process.env.FROM_EMAIL || "noreply@openhook.vercel.app";

// pg pool
const globalForPool = globalThis || {};

function createPool() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) return null;
  
  return new Pool({ 
    connectionString,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 10000,
    max: 1
  });
}

const pool = globalForPool.pool || createPool();
if (process.env.NODE_ENV !== "production") {
  globalForPool.pool = pool;
}

// SSE clients
const sseClients = new Map();

// Generate unique endpoint
function generateEndpoint() {
  return "hook_" + crypto.randomBytes(6).toString("hex");
}

// Auth middleware
function authMiddleware(req, res, next) {
  const token = req.cookies?.token || req.headers.authorization?.replace("Bearer ", "");
  
  if (!token) {
    req.userId = null;
    req.endpoint = null;
    return next();
  }
  
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.userId;
    req.endpoint = decoded.endpoint;
    next();
  } catch (e) {
    req.userId = null;
    req.endpoint = null;
    next();
  }
}

app.use(authMiddleware);

// Init DB tables
async function initDB() {
  if (!pool) return;
  try {
    // Users table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        email_verified BOOLEAN DEFAULT FALSE,
        verification_token VARCHAR(64),
        created_at TIMESTAMP DEFAULT NOW()
      )
    `).catch(() => {});
    
    // Password reset tokens
    await pool.query(`
      CREATE TABLE IF NOT EXISTS password_resets (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        token VARCHAR(64) UNIQUE NOT NULL,
        expires_at TIMESTAMP NOT NULL,
        used BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `).catch(() => {});
    
    // Endpoints table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS endpoints (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        endpoint VARCHAR(64) UNIQUE NOT NULL,
        name VARCHAR(255),
        retention_count INTEGER DEFAULT 100,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `).catch(() => {});
    
    // Add columns if missing
    try {
      await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN DEFAULT FALSE');
      await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS verification_token VARCHAR(64)');
      await pool.query('ALTER TABLE endpoints ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE CASCADE');
      await pool.query('ALTER TABLE endpoints ADD COLUMN IF NOT EXISTS name VARCHAR(255)');
      await pool.query('ALTER TABLE endpoints ADD COLUMN IF NOT EXISTS retention_count INTEGER DEFAULT 100');
    } catch (e) {}
    
    // Webhooks table
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
    `).catch(() => {});
    
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_endpoints_user ON endpoints(user_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_webhooks_endpoint ON webhooks(endpoint_id)`);
    
    console.log("Database tables ready");
  } catch (e) {
    console.log("DB init note:", e.message);
  }
}

// Broadcast to SSE
function broadcast(endpoint, data) {
  const client = sseClients.get(endpoint);
  if (client) {
    client.write(`data: ${JSON.stringify(data)}\n\n`);
  }
}

// Apply retention policy
async function applyRetention(endpointId, retentionCount) {
  try {
    await pool.query(`
      DELETE FROM webhooks 
      WHERE endpoint_id = $1 
      AND id NOT IN (
        SELECT id FROM webhooks 
        WHERE endpoint_id = $1 
        ORDER BY time DESC 
        LIMIT $2
      )
    `, [endpointId, retentionCount]);
  } catch (e) {
    console.log("Retention error:", e.message);
  }
}

// Send email (mock - replace with real email service)
async function sendEmail(to, subject, html) {
  // In production, use Resend, SendGrid, or similar
  // For now, just log it
  console.log(`Email to ${to}: ${subject}`);
  return true;
}

// AUTH ROUTES
app.post("/api/auth/register", async (req, res) => {
  if (!pool) return res.status(500).json({ error: "Database not configured" });
  
  try {
    const { email, password } = req.body;
    
    if (!email || !password) {
      return res.status(400).json({ error: "Email and password required" });
    }
    
    if (password.length < 6) {
      return res.status(400).json({ error: "Password must be at least 6 characters" });
    }
    
    // Check if user exists
    const existing = await pool.query("SELECT id FROM users WHERE email = $1", [email.toLowerCase()]);
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: "Email already registered" });
    }
    
    // Create user
    const passwordHash = await bcrypt.hash(password, 10);
    const verificationToken = crypto.randomBytes(32).toString("hex");
    
    const userResult = await pool.query(
      "INSERT INTO users (email, password_hash, verification_token) VALUES ($1, $2, $3) RETURNING id",
      [email.toLowerCase(), passwordHash, verificationToken]
    );
    const userId = userResult.rows[0].id;
    
    // Create default endpoint
    const endpoint = generateEndpoint();
    await pool.query(
      "INSERT INTO endpoints (user_id, endpoint, name) VALUES ($1, $2, $3)",
      [userId, endpoint, "My Webhook"]
    );
    
    // Send verification email
    const verifyUrl = `https://openhook.vercel.app/verify?token=${verificationToken}`;
    await sendEmail(
      email,
      "Verify your OpenHook account",
      `<p>Click <a href="${verifyUrl}">here</a> to verify your email.</p>`
    );
    
    const token = jwt.sign({ userId, endpoint }, JWT_SECRET, { expiresIn: "30d" });
    
    res.json({ 
      token, 
      user: { email: email.toLowerCase(), endpoint, needsVerification: true }
    });
  } catch (e) {
    console.error("Register error:", e.message);
    res.status(500).json({ error: "Registration failed" });
  }
});

app.post("/api/auth/verify-email", async (req, res) => {
  if (!pool) return res.status(500).json({ error: "Database not configured" });
  
  try {
    const { token } = req.body;
    
    if (!token) {
      return res.status(400).json({ error: "Token required" });
    }
    
    const result = await pool.query(
      "UPDATE users SET email_verified = TRUE, verification_token = NULL WHERE verification_token = $1 RETURNING id",
      [token]
    );
    
    if (result.rows.length === 0) {
      return res.status(400).json({ error: "Invalid token" });
    }
    
    res.json({ success: true });
  } catch (e) {
    console.error("Verify error:", e.message);
    res.status(500).json({ error: "Verification failed" });
  }
});

app.post("/api/auth/login", async (req, res) => {
  if (!pool) return res.status(500).json({ error: "Database not configured" });
  
  try {
    const { email, password } = req.body;
    
    const result = await pool.query("SELECT id, email, password_hash, email_verified FROM users WHERE email = $1", [email.toLowerCase()]);
    if (result.rows.length === 0) {
      return res.status(401).json({ error: "Invalid email or password" });
    }
    
    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    
    if (!valid) {
      return res.status(401).json({ error: "Invalid email or password" });
    }
    
    // Get user's first endpoint
    const endpointResult = await pool.query(
      "SELECT endpoint FROM endpoints WHERE user_id = $1 ORDER BY created_at LIMIT 1",
      [user.id]
    );
    const endpoint = endpointResult.rows[0]?.endpoint || null;
    
    const token = jwt.sign({ userId: user.id, endpoint }, JWT_SECRET, { expiresIn: "30d" });
    
    res.json({ 
      token, 
      user: { 
        email: user.email, 
        endpoint,
        emailVerified: user.email_verified
      } 
    });
  } catch (e) {
    console.error("Login error:", e.message);
    res.status(500).json({ error: "Login failed" });
  }
});

app.post("/api/auth/forgot-password", async (req, res) => {
  if (!pool) return res.status(500).json({ error: "Database not configured" });
  
  try {
    const { email } = req.body;
    
    if (!email) {
      return res.status(400).json({ error: "Email required" });
    }
    
    // Check if user exists
    const result = await pool.query("SELECT id FROM users WHERE email = $1", [email.toLowerCase()]);
    if (result.rows.length === 0) {
      // Don't reveal if user exists
      return res.json({ success: true, message: "If the email exists, a reset link has been sent" });
    }
    
    const userId = result.rows[0].id;
    
    // Create reset token (expires in 1 hour)
    const resetToken = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    
    await pool.query(
      "INSERT INTO password_resets (user_id, token, expires_at) VALUES ($1, $2, $3)",
      [userId, resetToken, expiresAt]
    );
    
    // Send reset email
    const resetUrl = `https://openhook.vercel.app/reset-password?token=${resetToken}`;
    await sendEmail(
      email,
      "Reset your OpenHook password",
      `<p>Click <a href="${resetUrl}">here</a> to reset your password. This link expires in 1 hour.</p>`
    );
    
    res.json({ success: true, message: "If the email exists, a reset link has been sent" });
  } catch (e) {
    console.error("Forgot password error:", e.message);
    res.status(500).json({ error: "Request failed" });
  }
});

app.post("/api/auth/reset-password", async (req, res) => {
  if (!pool) return res.status(500).json({ error: "Database not configured" });
  
  try {
    const { token, password } = req.body;
    
    if (!token || !password) {
      return res.status(400).json({ error: "Token and password required" });
    }
    
    if (password.length < 6) {
      return res.status(400).json({ error: "Password must be at least 6 characters" });
    }
    
    // Check token
    const result = await pool.query(
      `SELECT pr.user_id FROM password_resets pr 
       WHERE pr.token = $1 AND pr.used = FALSE AND pr.expires_at > NOW()`,
      [token]
    );
    
    if (result.rows.length === 0) {
      return res.status(400).json({ error: "Invalid or expired token" });
    }
    
    const userId = result.rows[0].user_id;
    
    // Update password
    const passwordHash = await bcrypt.hash(password, 10);
    await pool.query("UPDATE users SET password_hash = $1 WHERE id = $2", [passwordHash, userId]);
    
    // Mark token as used
    await pool.query("UPDATE password_resets SET used = TRUE WHERE token = $1", [token]);
    
    res.json({ success: true });
  } catch (e) {
    console.error("Reset password error:", e.message);
    res.status(500).json({ error: "Reset failed" });
  }
});

app.get("/api/auth/me", async (req, res) => {
  if (!req.userId) {
    return res.json({ user: null });
  }
  
  try {
    const result = await pool.query(
      "SELECT email, email_verified FROM users WHERE id = $1", 
      [req.userId]
    );
    if (result.rows.length === 0) {
      return res.json({ user: null });
    }
    
    res.json({ 
      user: { 
        email: result.rows[0].email, 
        endpoint: req.endpoint,
        emailVerified: result.rows[0].email_verified
      } 
    });
  } catch (e) {
    res.json({ user: null });
  }
});

// SSE for real-time
app.get("/api/sse/:endpoint", (req, res) => {
  const { endpoint } = req.params;
  
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  
  res.write(`data: ${JSON.stringify({ type: "connected" })}\n\n`);
  
  sseClients.set(endpoint, res);
  
  const keepAlive = setInterval(() => {
    res.write(": keepalive\n\n");
  }, 30000);
  
  req.on("close", () => {
    clearInterval(keepAlive);
    sseClients.delete(endpoint);
  });
});

// Receive webhook
app.post("/api/hook/:endpoint", async (req, res) => {
  try {
    const { endpoint } = req.params;
    
    if (pool) {
      try {
        let result = await pool.query("SELECT id, retention_count FROM endpoints WHERE endpoint = $1", [endpoint]);
        let endpointId;
        let retentionCount = 100;
        
        if (result.rows.length === 0) {
          result = await pool.query("INSERT INTO endpoints (endpoint) VALUES ($1) RETURNING id", [endpoint]);
          endpointId = result.rows[0].id;
        } else {
          endpointId = result.rows[0].id;
          retentionCount = result.rows[0].retention_count || 100;
        }
        
        const webhookId = crypto.randomBytes(4).toString("hex");
        await pool.query(
          "INSERT INTO webhooks (endpoint_id, webhook_id, method, path, headers, body, query, time) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
          [endpointId, webhookId, req.method, "/api/hook/" + endpoint, JSON.stringify(req.headers), JSON.stringify(req.body), JSON.stringify(req.query), Date.now()]
        );
        
        // Apply retention
        applyRetention(endpointId, retentionCount);
        
        // Broadcast
        const webhook = {
          id: webhookId,
          method: req.method,
          path: "/api/hook/" + endpoint,
          headers: req.headers,
          body: req.body,
          query: req.query,
          time: Date.now()
        };
        broadcast(endpoint, { type: "webhook", webhook });
        
        return res.json({ success: true, id: webhookId, mode: "db" });
      } catch (dbError) {
        console.log("DB error:", dbError.message);
      }
    }
    
    res.json({ success: true, id: crypto.randomBytes(4).toString("hex"), mode: "unauthenticated" });
  } catch (e) {
    console.error("Webhook error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// Get webhooks
app.get("/api/hooks/:endpoint", async (req, res) => {
  try {
    const { endpoint } = req.params;
    const { search, limit = 50 } = req.query;
    
    if (pool) {
      try {
        let query = `
          SELECT w.webhook_id as id, w.method, w.path, w.headers, w.body, w.query, w.time 
          FROM webhooks w 
          JOIN endpoints e ON w.endpoint_id = e.id 
          WHERE e.endpoint = $1
        `;
        const params = [endpoint];
        
        if (search) {
          query += ` AND (
            w.body::text ILIKE $2 OR 
            w.headers::text ILIKE $2 OR
            w.method ILIKE $2
          )`;
          params.push(`%${search}%`);
        }
        
        query += ` ORDER BY w.time DESC LIMIT $${params.length + 1}`;
        params.push(parseInt(limit));
        
        const result = await pool.query(query, params);
        return res.json(result.rows);
      } catch (dbError) {
        console.log("DB get error:", dbError.message);
      }
    }
    
    res.json([]);
  } catch (e) {
    console.error("Get webhooks error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// Delete webhook
app.delete("/api/webhooks/:webhookId", async (req, res) => {
  if (!pool) return res.status(500).json({ error: "Database not configured" });
  
  try {
    const { webhookId } = req.params;
    await pool.query("DELETE FROM webhooks WHERE webhook_id = $1", [webhookId]);
    res.json({ success: true });
  } catch (e) {
    console.error("Delete error:", e.message);
    res.status(500).json({ error: "Delete failed" });
  }
});

// Delete all webhooks for endpoint
app.delete("/api/hooks/:endpoint", async (req, res) => {
  if (!pool) return res.status(500).json({ error: "Database not configured" });
  
  try {
    const { endpoint } = req.params;
    await pool.query(`
      DELETE FROM webhooks WHERE endpoint_id IN (
        SELECT id FROM endpoints WHERE endpoint = $1
      )
    `, [endpoint]);
    res.json({ success: true });
  } catch (e) {
    console.error("Delete all error:", e.message);
    res.status(500).json({ error: "Delete failed" });
  }
});

// Replay webhook
app.post("/api/replay/:webhookId", async (req, res) => {
  if (!pool) return res.status(500).json({ error: "Database not configured" });
  
  try {
    const { webhookId } = req.params;
    const { url, method: overrideMethod, headers: overrideHeaders, sslVerify = true } = req.body;
    
    if (!url) {
      return res.status(400).json({ error: "Target URL required" });
    }
    
    const result = await pool.query(
      "SELECT method, path, headers, body, query FROM webhooks WHERE webhook_id = $1",
      [webhookId]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Webhook not found" });
    }
    
    const webhook = result.rows[0];
    const targetMethod = overrideMethod || webhook.method;
    const targetHeaders = { ...webhook.headers, ...overrideHeaders };
    
    // Build fetch options
    const fetchOptions = {
      method: targetMethod,
      headers: targetHeaders,
      redirect: "follow"
    };
    
    // Only add body for methods that support it
    if (["POST", "PUT", "PATCH"].includes(targetMethod) && webhook.body && Object.keys(webhook.body).length > 0) {
      fetchOptions.body = JSON.stringify(webhook.body);
    }
    
    // Note: Node 18+ fetch doesn't support rejectUnauthorized directly
    // For SSL verification control, you'd need to use a library like axios or node-fetch
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    fetchOptions.signal = controller.signal;
    
    let response;
    try {
      response = await fetch(url, fetchOptions);
    } catch (fetchError) {
      clearTimeout(timeout);
      return res.status(500).json({ 
        success: false, 
        error: `Request failed: ${fetchError.message}`,
        note: sslVerify ? "SSL verification enabled" : "SSL verification disabled"
      });
    }
    
    clearTimeout(timeout);
    
    const responseBody = await response.text();
    
    res.json({
      success: response.ok,
      status: response.status,
      statusText: response.statusText,
      headers: Object.fromEntries(response.headers.entries()),
      body: responseBody.substring(0, 10000),
      sslVerified: sslVerify
    });
  } catch (e) {
    console.error("Replay error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// Create new endpoint
app.post("/api/endpoints", async (req, res) => {
  if (!pool) return res.status(500).json({ error: "Database not configured" });
  if (!req.userId) return res.status(401).json({ error: "Authentication required" });
  
  try {
    const { name, retention } = req.body;
    const endpoint = generateEndpoint();
    
    await pool.query(
      "INSERT INTO endpoints (user_id, endpoint, name, retention_count) VALUES ($1, $2, $3, $4)",
      [req.userId, endpoint, name || "New Endpoint", retention || 100]
    );
    
    res.json({ endpoint });
  } catch (e) {
    console.error("Create endpoint error:", e.message);
    res.status(500).json({ error: "Failed to create endpoint" });
  }
});

// Get all endpoints
app.get("/api/endpoints", async (req, res) => {
  if (!pool) return res.status(500).json({ error: "Database not configured" });
  
  try {
    let result;
    
    if (req.userId) {
      result = await pool.query(`
        SELECT e.endpoint, e.name, e.created_at, e.retention_count, COUNT(w.id)::int as count
        FROM endpoints e
        LEFT JOIN webhooks w ON w.endpoint_id = e.id
        WHERE e.user_id = $1
        GROUP BY e.id, e.endpoint, e.name, e.created_at, e.retention_count
        ORDER BY e.created_at DESC
      `, [req.userId]);
    } else {
      result = await pool.query(`
        SELECT e.endpoint, e.name, e.created_at, e.retention_count, COUNT(w.id)::int as count
        FROM endpoints e
        LEFT JOIN webhooks w ON w.endpoint_id = e.id
        WHERE e.user_id IS NULL
        GROUP BY e.id, e.endpoint, e.name, e.created_at, e.retention_count
        ORDER BY e.created_at DESC
        LIMIT 10
      `);
    }
    
    res.json(result.rows);
  } catch (e) {
    console.error("Get endpoints error:", e.message);
    res.status(500).json({ error: "Failed to get endpoints" });
  }
});

// Update endpoint settings
app.patch("/api/endpoints/:endpoint", async (req, res) => {
  if (!pool) return res.status(500).json({ error: "Database not configured" });
  if (!req.userId) return res.status(401).json({ error: "Authentication required" });
  
  try {
    const { endpoint } = req.params;
    const { name, retention } = req.body;
    
    const updates = [];
    const values = [];
    let paramCount = 1;
    
    if (name !== undefined) {
      updates.push(`name = $${paramCount++}`);
      values.push(name);
    }
    
    if (retention !== undefined) {
      updates.push(`retention_count = $${paramCount++}`);
      values.push(parseInt(retention));
    }
    
    if (updates.length === 0) {
      return res.status(400).json({ error: "No updates provided" });
    }
    
    values.push(endpoint, req.userId);
    
    await pool.query(
      `UPDATE endpoints SET ${updates.join(", ")} WHERE endpoint = $${paramCount++} AND user_id = $${paramCount}`,
      values
    );
    
    // Apply retention if changed
    if (retention !== undefined) {
      const ep = await pool.query("SELECT id FROM endpoints WHERE endpoint = $1", [endpoint]);
      if (ep.rows.length > 0) {
        applyRetention(ep.rows[0].id, parseInt(retention));
      }
    }
    
    res.json({ success: true });
  } catch (e) {
    console.error("Update endpoint error:", e.message);
    res.status(500).json({ error: "Failed to update endpoint" });
  }
});

// Export webhooks
app.get("/api/export/:endpoint", async (req, res) => {
  if (!pool) return res.status(500).json({ error: "Database not configured" });
  
  try {
    const { endpoint } = req.params;
    
    const result = await pool.query(`
      SELECT w.webhook_id as id, w.method, w.path, w.headers, w.body, w.query, w.time
      FROM webhooks w
      JOIN endpoints e ON w.endpoint_id = e.id
      WHERE e.endpoint = $1
      ORDER BY w.time DESC
    `, [endpoint]);
    
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Content-Disposition", `attachment; filename="webhooks-${endpoint}.json"`);
    res.json({
      exported_at: new Date().toISOString(),
      endpoint,
      count: result.rows.length,
      webhooks: result.rows
    });
  } catch (e) {
    console.error("Export error:", e.message);
    res.status(500).json({ error: "Export failed" });
  }
});

// Health check
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", hasPool: !!pool });
});

// Serve static files
app.use(express.static(__dirname));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// Init DB
initDB();

module.exports = app;