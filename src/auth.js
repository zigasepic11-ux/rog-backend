const jwt = require("jsonwebtoken");

function requireAuth(req, res, next) {
  try {
    const h = req.headers.authorization || "";
    const [type, token] = h.split(" ");

    if (type !== "Bearer" || !token) {
      return res.status(401).json({ error: "Missing Bearer token" });
    }

    const secret = process.env.JWT_SECRET;
    if (!secret) return res.status(500).json({ error: "Missing JWT_SECRET in .env" });

    req.user = jwt.verify(token, secret);
    return next();
  } catch {
    return res.status(401).json({ error: "Invalid token" });
  }
}

module.exports = { requireAuth };
