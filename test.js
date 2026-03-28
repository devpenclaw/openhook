const express = require("express");
const app = express();
app.use(express.json());
app.get("/api/test", (req, res) => res.json({ok: true}));
app.listen(3001, () => console.log("Server on 3001"));
