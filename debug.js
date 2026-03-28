const express = require("express");
const path = require("path");
const crypto = require("crypto");

console.log("Starting server...");

const app = express();
console.log("Express loaded");

app.use(express.json());
console.log("JSON middleware added");

app.get("/api/test", (req, res) => {
  res.json({ ok: true });
});

console.log("Routes defined");

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
