// The outbox of alerts and customer messages, and the channels configured on this server.
const notify = require("../services/notify");
const { auth } = require("../http/auth");
const { err } = require("../http/helpers");

function mount(app) {
  app.get("/api/notifications", auth, (req, res) => res.json(notify.list(req.mid)));
  app.get("/api/notifications/channels", auth, (_req, res) => res.json({ configured: notify.configured(), available: Object.keys(notify.providers) }));
  app.post("/api/notifications/:id/retry", auth, (req, res) => {
    if (!notify.retry(Number(req.params.id), req.mid)) return err(res, 404, "not_found", "No retryable notification with that id");
    res.json({ ok: true });
  });
}

module.exports = { mount };
